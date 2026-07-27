import { and, count, eq, sql } from 'drizzle-orm';
import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from 'viem';

import type { ArenaDatabase } from '../db/index.js';
import { chainCursors, scores, wallets } from '../db/schema.js';
import type { EventJournal } from '../journal.js';
import { flagMintedEvent } from './abi.js';
import type { ChainProfile } from './profile.js';
import { ensureChainTables, recordSolve } from './storage.js';

const defaultBatchSize = 2_000n;
const maxBackoffMs = 30_000;

export interface FlagWatcherOptions {
  profile: ChainProfile;
  runId: string;
  journal: EventJournal;
  startBlock?: bigint | number;
  pollMs?: number;
  batchSize?: bigint | number;
  database?: ArenaDatabase;
  client?: PublicClient;
}

function toBlockNumber(value: bigint | number, field: string): bigint {
  const converted = BigInt(value);
  if (converted < 0n) {
    throw new Error(`${field} cannot be negative`);
  }
  return converted;
}

function toSqliteInteger(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} exceeds SQLite's safe integer range`);
  }
  return Number(value);
}

function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function scoreCount(database: ArenaDatabase, runId: string, entrantId: string): number {
  ensureChainTables(database);
  const result = database
    .select({ value: count() })
    .from(scores)
    .where(and(eq(scores.runId, runId), eq(scores.entrantId, entrantId)))
    .get();
  return result?.value ?? 0;
}

export function flagCount(
  runId: string,
  entrantId: string,
  database: ArenaDatabase,
): number {
  return scoreCount(database, runId, entrantId);
}

export class FlagWatcher {
  private readonly client: PublicClient;
  private readonly database: ArenaDatabase;
  private readonly contractAddress: string;
  private readonly startBlock: bigint;
  private readonly pollMs: number;
  private readonly batchSize: bigint;

  constructor(private readonly options: FlagWatcherOptions) {
    this.database = options.database ?? options.journal.database;
    this.client = options.client ?? createPublicClient({ transport: http(options.profile.rpcUrl) });
    this.contractAddress = options.profile.nftFlags.toLowerCase();
    this.startBlock = toBlockNumber(options.startBlock ?? 0n, 'startBlock');
    this.pollMs = Math.max(0, options.pollMs ?? 1_000);
    this.batchSize = toBlockNumber(options.batchSize ?? defaultBatchSize, 'batchSize');
    if (this.batchSize === 0n) {
      throw new Error('batchSize must be greater than zero');
    }
    ensureChainTables(this.database);
  }

  private cursor(): bigint | null {
    const row = this.database
      .select({ lastProcessedBlock: chainCursors.lastProcessedBlock })
      .from(chainCursors)
      .where(and(
        eq(chainCursors.runId, this.options.runId),
        eq(chainCursors.contractAddress, this.contractAddress),
      ))
      .get();
    return row ? BigInt(row.lastProcessedBlock) : null;
  }

  private resumeBlock(): bigint {
    const cursor = this.cursor();
    if (cursor === null) {
      return this.startBlock;
    }
    const overlap = BigInt(this.options.profile.confirmations);
    const resume = cursor + 1n - overlap;
    return resume > this.startBlock ? resume : this.startBlock;
  }

  private nextUnprocessedBlock(fallback: bigint): bigint {
    const cursor = this.cursor();
    return cursor === null ? fallback : cursor + 1n;
  }

  private updateCursor(lastProcessedBlock: bigint): void {
    this.database
      .insert(chainCursors)
      .values({
        runId: this.options.runId,
        contractAddress: this.contractAddress,
        lastProcessedBlock: toSqliteInteger(lastProcessedBlock, 'lastProcessedBlock'),
      })
      .onConflictDoUpdate({
        target: [chainCursors.runId, chainCursors.contractAddress],
        set: {
          lastProcessedBlock: sql`max(
            ${chainCursors.lastProcessedBlock},
            excluded.last_processed_block
          )`,
        },
      })
      .run();
  }

  private entrantMap(): ReadonlyMap<string, string> {
    const rows = this.database
      .select({ entrantId: wallets.entrantId, address: wallets.address })
      .from(wallets)
      .where(eq(wallets.runId, this.options.runId))
      .all();
    return new Map(rows.map((row) => [row.address.toLowerCase(), row.entrantId]));
  }

  private insertScore(
    entrantId: string,
    entrantAddress: Address,
    challengeId: bigint,
    tokenId: bigint,
    txHash: string,
    blockNumber: bigint,
  ): boolean {
    return recordSolve(this.database, this.options.journal, {
      runId: this.options.runId,
      entrantId,
      entrantAddress,
      challengeId: toSqliteInteger(challengeId, 'challengeId'),
      tokenId: tokenId.toString(),
      txHash,
      blockNumber: toSqliteInteger(blockNumber, 'blockNumber'),
    });
  }

  async scanOnce(fromBlock: bigint | number): Promise<number> {
    let rangeStart = toBlockNumber(fromBlock, 'fromBlock');
    const head = await this.client.getBlockNumber();
    const confirmations = BigInt(this.options.profile.confirmations);
    if (head < confirmations) {
      return 0;
    }

    const confirmedHead = head - confirmations;
    if (rangeStart > confirmedHead) {
      return 0;
    }

    const entrants = this.entrantMap();
    let insertedCount = 0;

    while (rangeStart <= confirmedHead) {
      const batchEnd = rangeStart + this.batchSize - 1n;
      const rangeEnd = batchEnd < confirmedHead ? batchEnd : confirmedHead;
      const logs = await this.client.getLogs({
        address: this.options.profile.nftFlags,
        event: flagMintedEvent,
        fromBlock: rangeStart,
        toBlock: rangeEnd,
      });

      for (const log of logs) {
        const { minter, tokenId, challengeId } = log.args;
        if (
          minter === undefined
          || tokenId === undefined
          || challengeId === undefined
          || log.transactionHash === null
          || log.blockNumber === null
        ) {
          throw new Error('FlagMinted log is missing a required field');
        }
        const entrantId = entrants.get(minter.toLowerCase());
        if (!entrantId) {
          continue;
        }
        if (this.insertScore(
          entrantId,
          minter,
          challengeId,
          tokenId,
          log.transactionHash,
          log.blockNumber,
        )) {
          insertedCount += 1;
        }
      }

      this.updateCursor(rangeEnd);
      rangeStart = rangeEnd + 1n;
    }

    return insertedCount;
  }

  async watch(signal: AbortSignal): Promise<void> {
    let nextBlock = this.resumeBlock();
    let failures = 0;

    while (!signal.aborted) {
      try {
        await this.scanOnce(nextBlock);
        nextBlock = this.nextUnprocessedBlock(nextBlock);
        failures = 0;
        if (!(await wait(this.pollMs, signal))) {
          return;
        }
      } catch {
        nextBlock = this.nextUnprocessedBlock(nextBlock);
        failures += 1;
        const baseDelay = Math.max(10, this.pollMs);
        const backoff = Math.min(maxBackoffMs, baseDelay * (2 ** Math.min(failures - 1, 10)));
        if (!(await wait(backoff, signal))) {
          return;
        }
      }
    }
  }

  flagCount(runId: string, entrantId: string): number {
    return scoreCount(this.database, runId, entrantId);
  }
}
