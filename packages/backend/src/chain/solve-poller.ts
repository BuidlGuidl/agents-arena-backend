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

  constructor(private readonly options: SolvePollerOptions) {
    this.database = options.database ?? options.journal.database;
    // batch groups the tick's hasMinted reads into one JSON-RPC request. Multicall3
    // would do the same but is not deployed on the local hardhat chain (ADR-0010).
    this.client = options.client ?? createPublicClient({
      transport: http(options.profile.rpcUrl, { batch: true }),
    });
    this.pollMs = Math.max(0, options.pollMs ?? DEFAULT_POLL_MS);
    this.searchFrom = options.fromBlock ?? 0n;
    ensureChainTables(this.database);
  }

  /** Read every unscored pair once and record what turned true. Returns solves written. */
  async pollOnce(): Promise<number> {
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

    const minted = await Promise.all(pairs.map((pair) => this.hasMinted(pair, confirmedBlock)));
    const solved = pairs.filter((_, index) => minted[index] === true);
    if (solved.length === 0) {
      this.searchFrom = confirmedBlock + 1n;
      return 0;
    }

    const captures = await Promise.all(
      solved.map((pair) => this.recoverCapture(pair, confirmedBlock)),
    );
    const recovered = captures.filter((capture): capture is Capture => capture !== null);
    // A pair whose mint log was not found keeps the search window open, otherwise the
    // next tick would start past the block the log sits in and never recover it.
    if (recovered.length === solved.length) {
      this.searchFrom = confirmedBlock + 1n;
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
    return written;
  }

  /** Poll until the run aborts. Never resolves on its own, so callers must not await it. */
  async watch(signal: AbortSignal): Promise<void> {
    let failures = 0;

    while (!signal.aborted) {
      let delayMs = this.pollMs;
      try {
        await this.pollOnce();
        failures = 0;
      } catch {
        failures += 1;
        delayMs = Math.min(MAX_BACKOFF_MS, Math.max(10, this.pollMs) * 2 ** Math.min(failures - 1, 10));
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
      // no contract. A wrong address is ADR-0009's startup cross-check to catch, not this.
      if (error instanceof BaseError
        && error.walk((cause) => cause instanceof ContractFunctionZeroDataError) !== null) {
        return false;
      }
      throw error;
    }
  }

  // minter and challengeId are both indexed, so this filter matches at most the twelve
  // mints one burner can ever produce, which is why a full-range scan stays one call.
  private async recoverCapture(pair: Pair, toBlock: bigint): Promise<Capture | null> {
    const logs = await this.client.getLogs({
      address: this.options.profile.nftFlags,
      event: flagMintedEvent,
      args: { minter: pair.address, challengeId: BigInt(pair.challengeId) },
      fromBlock: this.searchFrom,
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
    // Nothing awaits this loop, so an escaped rejection would take down the server
    // process. A dead poller means a frozen board, which the operator has to see.
    new SolvePoller({ profile, runId: run.id, journal }).watch(signal).catch((error: unknown) => {
      journal.append(run.id, 'chain:flags', 'run.error', {
        message: `solve poller stopped: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
  };
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
