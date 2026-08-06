import type { ArenaEvent, EntrantSummary, RunState } from '../../../contract/arena-types';

// The global `id` is a journal-wide autoincrement shared across runs, so within
// one run it legitimately skips whenever another run writes events. Data loss is
// only real when a per-source `seq` skips: seq is contiguous per (runId, source).
// This module tracks per-source seq for gap detection and dedupes on `id` so the
// replay overlap after an EventSource reconnect never double-counts an event.

export const RUN_SOURCE = 'run';

export interface FeedGap {
  source: string;
  from: number; // last seq seen for the source
  to: number; // seq of the event that skipped ahead
}

export interface FeedEntry {
  event: ArenaEvent;
  result?: Extract<ArenaEvent, { type: 'tool.result' }>;
}

export interface FeedState {
  events: ArenaEvent[];
  entries: FeedEntry[];
  seenIds: Set<number>; // every global id already ingested
  lastSeqBySource: Record<string, number>; // highest seq seen per source
  gaps: FeedGap[]; // per-source seq skips observed so far
}

export function initialFeedState(): FeedState {
  return { events: [], entries: [], seenIds: new Set<number>(), lastSeqBySource: {}, gaps: [] };
}

// Ingest one streamed event. Pure: returns the same state object when the event
// is a duplicate so React can skip re-rendering.
export function ingestEvent(state: FeedState, event: ArenaEvent): FeedState {
  if (state.seenIds.has(event.id)) return state; // replay overlap after reconnect

  const lastSeq = state.lastSeqBySource[event.source];
  const gaps = lastSeq !== undefined && event.seq > lastSeq + 1
    ? [...state.gaps, { source: event.source, from: lastSeq, to: event.seq }]
    : state.gaps;

  const seenIds = new Set(state.seenIds);
  seenIds.add(event.id);
  let entries: FeedEntry[];
  if (event.type === 'tool.result') {
    const matchingCallIndex = findLatestUnresolvedCall(state.entries, event);
    entries = matchingCallIndex < 0
      ? [...state.entries, { event }]
      : state.entries.map((entry, index) => (
        index === matchingCallIndex ? { ...entry, result: event } : entry
      ));
  } else {
    entries = [...state.entries, { event }];
  }

  return {
    events: [...state.events, event],
    entries,
    seenIds,
    lastSeqBySource: {
      ...state.lastSeqBySource,
      [event.source]: lastSeq === undefined ? event.seq : Math.max(lastSeq, event.seq),
    },
    gaps,
  };
}

function findLatestUnresolvedCall(
  entries: FeedEntry[],
  event: Extract<ArenaEvent, { type: 'tool.result' }>,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (
      entry.event.source === event.source
      && entry.event.type === 'tool.call'
      && entry.event.payload.toolCallId === event.payload.toolCallId
      && entry.result === undefined
    ) {
      return index;
    }
  }
  return -1;
}

export function entriesForSource(entries: FeedEntry[], source: string): FeedEntry[] {
  return entries.filter((entry) => entry.event.source === source);
}

export function isRunLevel(event: ArenaEvent): boolean {
  return event.source === RUN_SOURCE;
}

export function gapsForSource(gaps: FeedGap[], source: string): FeedGap[] {
  return gaps.filter((gap) => gap.source === source);
}

// ---- wallet / funding derivation ----

export interface LaneWalletState {
  address: string | null; // resolved burner address, snapshot or wallet.assigned
  wei: string | null; // latest funding.balance wei, null before any balance event
  funded: boolean; // latest funding.balance funded flag
  awaitingFunds: boolean; // run is awaiting_funding and this lane is not funded yet
}

// Middle-truncate a hex address for display: 0x1234…abcd. The caller keeps the
// full address in a title attribute. Short strings pass through unchanged.
export function truncateAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

// Convert a wei integer decimal string to an ETH string, 4 decimal places max,
// trailing zeros trimmed. Dependency-free: BigInt-safe via plain string maths.
export function formatWei(wei: string): string {
  const negative = wei.startsWith('-');
  const digits = (negative ? wei.slice(1) : wei).replace(/^0+(?=\d)/, '');
  const padded = digits.padStart(19, '0'); // 18 fractional digits + >=1 integer digit
  const intPart = padded.slice(0, padded.length - 18);
  const frac = padded.slice(padded.length - 18, padded.length - 18 + 4).replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return frac ? `${sign}${intPart}.${frac}` : `${sign}${intPart}`;
}

// Fold a lane's events into its wallet view. The address falls back to the
// snapshot value, then the latest wallet.assigned / funding.balance overrides it.
// Balance and funded come from the latest funding.balance event for the lane.
export function deriveLaneWallet(
  laneEvents: ArenaEvent[],
  fallbackAddress: string | null,
  runState: RunState | undefined,
): LaneWalletState {
  let address = fallbackAddress;
  let wei: string | null = null;
  let funded = false;
  for (const event of laneEvents) {
    if (event.type === 'wallet.assigned') {
      address = event.payload.address;
    } else if (event.type === 'funding.balance') {
      address = event.payload.address;
      wei = event.payload.wei;
      funded = event.payload.funded;
    }
  }
  return { address, wei, funded, awaitingFunds: runState === 'awaiting_funding' && !funded };
}

export interface WaitingRoomEntry {
  entrantId: string;
  harness: string;
  address: string | null;
  wei: string | null;
  funded: boolean;
  // `pending` covers the window before the seed signature lands, when no burner
  // address exists to fund yet.
  status: 'pending' | 'waiting' | 'funded';
}

// One row per entrant for the waiting room: the same wallet fold the lanes use,
// widened to the whole roster so the funder reads every address in one list.
export function deriveWaitingRoom(
  entrants: readonly EntrantSummary[],
  entries: FeedEntry[],
  runState: RunState | undefined,
): WaitingRoomEntry[] {
  return entrants.map((entrant) => {
    const events = entriesForSource(entries, entrant.id).map((entry) => entry.event);
    const wallet = deriveLaneWallet(events, entrant.address, runState);
    return {
      entrantId: entrant.id,
      harness: entrant.harness,
      address: wallet.address,
      wei: wallet.wei,
      funded: wallet.funded,
      status: wallet.address === null ? 'pending' : wallet.funded ? 'funded' : 'waiting',
    };
  });
}

// One-line human summary for every ArenaEvent type. Any type the UI does not
// know renders through the raw fallback so the feed never blanks out.
export function describeEvent(event: ArenaEvent): string {
  switch (event.type) {
    case 'run.state':
      return `run → ${event.payload.state}${event.payload.reason ? ` (${event.payload.reason})` : ''}`;
    case 'entrant.status':
      return `status → ${event.payload.status}`;
    case 'agent.message':
      return `says: ${event.payload.text}`;
    case 'agent.reasoning':
      return `thinks: ${event.payload.text}`;
    case 'tool.call':
      return `${event.payload.tool} → running: ${event.payload.detail}`;
    case 'tool.result':
      return `${event.payload.tool} → ${event.payload.ok ? 'ok' : 'fail'}: ${event.payload.detail}`;
    case 'entrant.steered':
      return `steered: ${event.payload.text}`;
    case 'entrant.prompt':
      return `task: ${event.payload.text}`;
    case 'entrant.nudged':
      return `nudged (flags ${event.payload.flags}): ${event.payload.text}`;
    case 'director.broadcast':
      return `broadcast (${event.payload.targetEntrantIds.length} entrants): ${event.payload.text}`;
    case 'wallet.assigned':
      return `wallet ${event.payload.address}`;
    case 'funding.balance':
      return `balance ${formatWei(event.payload.wei)} eth${event.payload.funded ? ' (funded)' : ''}`;
    case 'score.flag':
      return `flag challenge ${event.payload.challengeId} token ${event.payload.tokenId} (${event.payload.txHash})`;
    case 'entrant.challenge':
      return `now on challenge ${event.payload.challengeId}`;
    case 'entrant.error':
      return `error: ${event.payload.message}`;
    case 'run.error':
      return `run error: ${event.payload.message}`;
    case 'usage': {
      const cost = event.payload.costUsd === null ? '' : ` · $${event.payload.costUsd.toFixed(4)}`;
      return `usage in ${event.payload.inputTokens} / out ${event.payload.outputTokens}${cost}`;
    }
    default:
      // Unknown-to-the-UI type: never blank the row, show the raw payload.
      return rawFallback(event);
  }
}

export function describeEntry(entry: FeedEntry): string {
  if (entry.event.type !== 'tool.call') return describeEvent(entry.event);
  if (entry.result === undefined) {
    return `${entry.event.payload.tool} → running: ${entry.event.payload.detail}`;
  }

  const callDetail = entry.event.payload.detail;
  const resultDetail = entry.result.payload.detail;
  const resultSuffix = resultDetail.length > 0 && resultDetail !== callDetail
    ? ` ⇒ ${resultDetail}`
    : '';
  return `${entry.event.payload.tool} → ${entry.result.payload.ok ? 'ok' : 'fail'}: ${callDetail}${resultSuffix}`;
}

function rawFallback(event: ArenaEvent): string {
  return `${(event as { type: string }).type}: ${JSON.stringify((event as { payload: unknown }).payload)}`;
}
