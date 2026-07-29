import { eq } from 'drizzle-orm';
import {
  BaseError,
  ContractFunctionZeroDataError,
  createPublicClient,
  getAddress,
  http,
  type Address,
  type PublicClient,
} from 'viem';

import type { EntrantRecord, RunRecord } from '../adapters/types.js';
import type { ArenaDatabase } from '../db/index.js';
import { scores, wallets } from '../db/schema.js';
import type { EventJournal } from '../journal.js';
import type { SolveWatch } from '../run-manager.js';
import { flagMintedEvent, nftFlagsAbi } from './abi.js';
import { activeChainProfile, getChainProfile, type ChainProfile } from './profile.js';
import { ensureChainTables, recordSolve } from './storage.js';

/** The CTF ships twelve challenges, so a changed set needs a change here (ADR-0010). */
export const CHALLENGE_IDS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

// Base produces a block every two seconds, so polling faster only buys duplicate reads.
const DEFAULT_POLL_MS = 3_000;
const MAX_BACKOFF_MS = 30_000;
// Three ticks of tolerance, so a single flaky response stays out of the run's event feed.
const FAILURES_BEFORE_REPORT = 3;

// mainnet.base.org rejects a JSON-RPC batch of 11 or more with -32014, and rejects an
// eth_getLogs span wider than 10,000 blocks with -32614. Both were measured against the
// live endpoint. Exceeding either fails the whole tick, which the backoff then repeats
// forever, so the poller has to stay inside them rather than discover them at race time.
const MAX_RPC_BATCH = 10;
const MAX_LOG_SPAN = 10_000n;

// Multicall3 sits at the same address on every chain that has it, base and base sepolia
// included. The poller asks the chain whether it is there rather than keying off the
// profile name, so a local chain that gains it later gets the aggregated path for free
// and a new network profile needs no code change.
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

// viem splits an aggregate3 every 1024 bytes of calldata by default, which would put a
// duel back at 2 calls and the ten entrants #2 asks for at 10, near enough to the
// unaggregated count to be pointless. One hasMinted call3 encodes to about 224 bytes, so
// this holds roughly 140 of them: one request per tick at any entrant count we run.
const MULTICALL_BATCH_BYTES = 32_768;

export interface SolvePollerOptions {
  profile: ChainProfile;
  runId: string;
  journal: EventJournal;
  pollMs?: number;
  fromBlock?: bigint;
  database?: ArenaDatabase;
  client?: PublicClient;
}

interface Pair {
  entrantId: string;
  address: Address;
  challengeId: number;
}

interface Capture extends Pair {
  tokenId: bigint;
  txHash: string;
  blockNumber: bigint;
  logIndex: number;
}

/**
 * Projects on-chain flag state into score rows and `score.flag` events.
 *
 * Every tick reads `hasMinted(address, challengeId)` for each entrant pair that has
 * not scored yet, at `head - confirmations`. There is no cursor: the scores table is
 * the record of what has been seen, so a restart resumes by reading the chain again.
 */
export class SolvePoller {
  private readonly client: PublicClient;
  private readonly database: ArenaDatabase;
  private readonly pollMs: number;
  private searchFrom: bigint;
  private aggregated: Promise<boolean> | null = null;
  private readonly reported = new Set<string>();

  constructor(private readonly options: SolvePollerOptions) {
    this.database = options.database ?? options.journal.database;
    // The fallback when Multicall3 is absent: batch groups the tick's hasMinted reads
    // into as few JSON-RPC requests as the endpoint takes. Neither the local hardhat
    // chain nor anvil deploys Multicall3, so this is the path local dev runs on.
    this.client = options.client ?? createPublicClient({
      transport: http(options.profile.rpcUrl, { batch: { batchSize: MAX_RPC_BATCH } }),
    });
    this.pollMs = Math.max(0, options.pollMs ?? DEFAULT_POLL_MS);
    this.searchFrom = options.fromBlock ?? 0n;
    ensureChainTables(this.database);
  }

  /** Read every unscored pair once and record what turned true. Returns solves written. */
  async pollOnce(signal?: AbortSignal): Promise<number> {
    const pairs = this.pendingPairs();
    if (pairs.length === 0) {
      return 0;
    }

    const head = await this.client.getBlockNumber();
    const depth = BigInt(this.options.profile.confirmations);
    if (head < depth) {
      return 0;
    }
    const confirmedBlock = head - depth;
    if (confirmedBlock < this.searchFrom) {
      return 0;
    }

    const minted = await this.readMintedFlags(pairs, confirmedBlock);
    const solved = pairs.filter((_, index) => minted[index] === true);
    if (solved.length === 0) {
      this.searchFrom = confirmedBlock + 1n;
      return 0;
    }

    const captures = await Promise.all(
      solved.map((pair) => this.recoverCapture(pair, confirmedBlock)),
    );
    const recovered = captures.filter((capture): capture is Capture => capture !== null);

    // The run ended while this tick was reading. score.flag after the run's own
    // finished event would put the journal out of order for every replaying client.
    if (signal?.aborted === true) {
      return 0;
    }

    // The journal is append-only and the frontend replays it in order, so two solves
    // found in the same tick must land in the order the chain saw them.
    recovered.sort((left, right) =>
      left.blockNumber === right.blockNumber
        ? left.logIndex - right.logIndex
        : Number(left.blockNumber - right.blockNumber));

    let written = 0;
    for (const capture of recovered) {
      if (this.record(capture)) {
        written += 1;
      }
    }

    // Only past the writes, and only when every solved pair produced a log. Advancing
    // earlier would move the window past a block whose solve is still unrecorded, and
    // no later search would ever look at that block again.
    if (recovered.length === solved.length && written === recovered.length) {
      this.searchFrom = confirmedBlock + 1n;
      this.clearReport('unrecovered');
    } else {
      // Holding searchFrom keeps retrying this pair every tick, and the retry only helps
      // if the log is inside the span. When it is not, the loop is permanent and silent,
      // so say so once rather than let the board hide a solve that already happened.
      const stuck = solved.filter((pair) => !recovered.some((capture) =>
        capture.entrantId === pair.entrantId && capture.challengeId === pair.challengeId));
      this.reportOnce(
        'unrecovered',
        `hasMinted is true but no FlagMinted log was found for ${stuck
          .map((pair) => `${pair.entrantId}/challenge ${pair.challengeId}`)
          .join(', ')}`,
      );
    }
    return written;
  }

  /** Poll until the run aborts. Never resolves on its own, so callers must not await it. */
  async watch(signal: AbortSignal): Promise<void> {
    let failures = 0;

    while (!signal.aborted) {
      let delayMs = this.pollMs;
      try {
        await this.pollOnce(signal);
        failures = 0;
        this.clearReport('poll');
      } catch (error) {
        failures += 1;
        delayMs = Math.min(MAX_BACKOFF_MS, Math.max(10, this.pollMs) * 2 ** Math.min(failures - 1, 10));
        // Backing off quietly forever is the worst outcome here: a wrong nftFlags address
        // on base throws every tick, and the board would sit at zero with nothing to read.
        if (failures >= FAILURES_BEFORE_REPORT) {
          this.reportOnce('poll', `solve poll failed ${failures} times in a row: ${describe(error)}`);
        }
      }
      if (!(await sleep(delayMs, signal))) {
        return;
      }
    }
  }

  private pendingPairs(): Pair[] {
    const entrantRows = this.database
      .select({ entrantId: wallets.entrantId, address: wallets.address })
      .from(wallets)
      .where(eq(wallets.runId, this.options.runId))
      .all();
    const scored = new Set(
      this.database
        .select({ address: scores.entrantAddress, challengeId: scores.challengeId })
        .from(scores)
        .where(eq(scores.runId, this.options.runId))
        .all()
        .map((row) => pairKey(row.address, row.challengeId)),
    );

    return entrantRows.flatMap((row) =>
      CHALLENGE_IDS
        .filter((challengeId) => !scored.has(pairKey(row.address, challengeId)))
        .map((challengeId) => ({
          entrantId: row.entrantId,
          address: getAddress(row.address),
          challengeId,
        })));
  }

  // One aggregate3 where the chain has Multicall3, otherwise one eth_call per pair.
  // The difference is flat versus linear in entrants: a duel is 3 batched requests
  // against 1, and the ten entrants #2 asks for are 12 against 1.
  private async readMintedFlags(pairs: readonly Pair[], blockNumber: bigint): Promise<boolean[]> {
    if (!(await this.hasMulticall())) {
      return Promise.all(pairs.map((pair) => this.hasMinted(pair, blockNumber)));
    }

    const results = await this.client.multicall({
      contracts: pairs.map((pair) => ({
        address: this.options.profile.nftFlags,
        abi: nftFlagsAbi,
        functionName: 'hasMinted',
        args: [pair.address, BigInt(pair.challengeId)],
      } as const)),
      multicallAddress: MULTICALL3_ADDRESS,
      batchSize: MULTICALL_BATCH_BYTES,
      allowFailure: true,
      blockNumber,
    });

    // aggregate3 reports a sub-call that returned nothing as a failure, which erases the
    // difference between a block before the NFTFlags deploy and a profile pointing at
    // the wrong address. Only the contract's own code settles that, same as the single
    // call path, so one read answers it for the whole tick.
    if (results.some((result) => result.status === 'failure')) {
      const code = await this.client.getCode({ address: this.options.profile.nftFlags, blockNumber });
      if (code !== undefined && code !== '0x') {
        const failure = results.find((result) => result.status === 'failure');
        throw failure?.error ?? new Error('hasMinted failed inside aggregate3');
      }
    }

    return results.map((result) => result.status === 'success' && result.result === true);
  }

  // Cached once answered: a chain does not gain or lose Multicall3 mid-run, and this
  // would otherwise be an extra request on every tick. Only an answer is cached, though.
  // Caching a failed probe would let one bad response hold a base run on the batched
  // path for its whole length, which is three times the requests and nothing to show why.
  private hasMulticall(): Promise<boolean> {
    this.aggregated ??= this.client
      .getCode({ address: MULTICALL3_ADDRESS })
      .then((code) => code !== undefined && code !== '0x')
      .catch(() => {
        this.aggregated = null;
        return false;
      });
    return this.aggregated;
  }

  // At most one report per reason per poller, so a failure that repeats every 3s for an
  // hour is one event and not 1,200. Clearing on recovery lets a later relapse speak up.
  private reportOnce(reason: string, message: string): void {
    if (this.reported.has(reason)) {
      return;
    }
    this.reported.add(reason);
    this.options.journal.append(this.options.runId, 'chain:flags', 'run.error', { message });
  }

  private clearReport(reason: string): void {
    this.reported.delete(reason);
  }

  private async hasMinted(pair: Pair, blockNumber: bigint): Promise<boolean> {
    try {
      return await this.client.readContract({
        address: this.options.profile.nftFlags,
        abi: nftFlagsAbi,
        functionName: 'hasMinted',
        args: [pair.address, BigInt(pair.challengeId)],
        blockNumber,
      });
    } catch (error) {
      // On a chain started minutes ago, head - confirmations can land before NFTFlags
      // was deployed, and the call returns no data. Nothing was minted at a block with
      // no contract, so that reads as false. Empty data from an address that does hold
      // code means the profile points at the wrong contract, which has to surface: the
      // pack cross-check does not cover it, because a profile with a briefingUrl mounts
      // no pack and never runs that check.
      if (error instanceof BaseError
        && error.walk((cause) => cause instanceof ContractFunctionZeroDataError) !== null) {
        const code = await this.client.getCode({
          address: this.options.profile.nftFlags,
          blockNumber,
        });
        if (code === undefined || code === '0x') {
          return false;
        }
      }
      throw error;
    }
  }

  // minter and challengeId are both indexed, so this filter matches at most the twelve
  // mints one burner can ever produce, which is why one call is enough. In the steady
  // state searchFrom is the previous tick's block, making the span a handful of blocks;
  // the floor only binds on a poller's first tick, where searchFrom is still 0.
  private async recoverCapture(pair: Pair, toBlock: bigint): Promise<Capture | null> {
    const floor = toBlock > MAX_LOG_SPAN ? toBlock - MAX_LOG_SPAN : 0n;
    const logs = await this.client.getLogs({
      address: this.options.profile.nftFlags,
      event: flagMintedEvent,
      args: { minter: pair.address, challengeId: BigInt(pair.challengeId) },
      fromBlock: this.searchFrom > floor ? this.searchFrom : floor,
      toBlock,
    });

    // hasMinted latched on the earliest mint, so a re-mint of the same challenge is
    // not the capture even though it carries a later tokenId.
    const first = logs
      .filter((log) => log.blockNumber !== null && log.transactionHash !== null)
      .sort((left, right) =>
        left.blockNumber === right.blockNumber
          ? (left.logIndex ?? 0) - (right.logIndex ?? 0)
          : Number((left.blockNumber ?? 0n) - (right.blockNumber ?? 0n)))
      .at(0);
    if (first?.args.tokenId === undefined || first.blockNumber === null || first.transactionHash === null) {
      return null;
    }

    return {
      ...pair,
      tokenId: first.args.tokenId,
      txHash: first.transactionHash,
      blockNumber: first.blockNumber,
      logIndex: first.logIndex ?? 0,
    };
  }

  private record(capture: Capture): boolean {
    return recordSolve(this.database, this.options.journal, {
      runId: this.options.runId,
      entrantId: capture.entrantId,
      entrantAddress: capture.address,
      challengeId: capture.challengeId,
      tokenId: capture.tokenId.toString(),
      txHash: capture.txHash,
      blockNumber: toSqliteInteger(capture.blockNumber),
    });
  }
}

/**
 * The run-scoped hook the server wires in. The poller owns no lifecycle of its own:
 * the run starts it after funding and aborts it when the run stops.
 */
export function createSolveWatch(journal: EventJournal, profileName?: string): SolveWatch {
  const profile = profileName === undefined ? activeChainProfile : getChainProfile(profileName);
  return (run: RunRecord, _entrants: readonly EntrantRecord[], signal: AbortSignal) => {
    if (run.preset !== 'docker-duel') {
      return;
    }
    // watch() reports its own poll failures through the journal and does not reject on
    // them, so getting here means the journal write itself threw. There is nowhere left
    // to record that, and nothing awaits this loop, so the choice is swallow it or let an
    // unhandled rejection take the server down mid-race.
    new SolvePoller({ profile, runId: run.id, journal }).watch(signal).catch(() => {});
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pairKey(address: string, challengeId: number): string {
  return `${address.toLowerCase()}:${challengeId}`;
}

function toSqliteInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Block number ${value} exceeds SQLite's safe integer range`);
  }
  return Number(value);
}

/** Resolves false when the signal aborts first, so the caller can return instead of looping. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
