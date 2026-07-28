import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ArenaEvent, EntrantSolve, EntrantSummary, RunSnapshot, RunState } from '../../../contract/arena-types';
import { projectSnapshot } from './project-snapshot';
import {
  deriveLaneWallet,
  describeEvent,
  eventsForSource,
  formatWei,
  gapsForSource,
  ingestEvent,
  initialFeedState,
  RUN_SOURCE,
  truncateAddress,
  type FeedState,
} from './feed-projection';
import { runPhase, styleForEvent } from './event-style';
import './styles.css';

const queryClient = new QueryClient();

const PRESETS = ['fake-duel', 'docker-duel'] as const;
type Preset = (typeof PRESETS)[number];

const HARNESS_COLOR: Record<string, string> = {
  codex: 'var(--codex)',
  opencode: 'var(--opencode)',
  claude: 'var(--claude)',
};

function App() {
  const cache = useQueryClient();
  const [preset, setPreset] = useState<Preset>('fake-duel');
  const [runId, setRunId] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedState>(initialFeedState);
  const [connection, setConnection] = useState('disconnected');
  const snapshot = useQuery({
    queryKey: ['run', runId],
    enabled: runId !== null,
    queryFn: async () => {
      const fetched = await fetchJson<{ run: RunSnapshot }>(`/runs/${runId}`).then((body) => body.run);
      // The SSE projection can be ahead of this response, and score.flag events are
      // consumed once, so the higher lastEventId wins.
      const projected = cache.getQueryData<RunSnapshot>(['run', runId]);
      return projected !== undefined && projected.lastEventId > fetched.lastEventId ? projected : fetched;
    },
  });
  const createRun = useMutation({
    mutationFn: async () => fetchJson<{ run: RunSnapshot }>('/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset, autoStart: true }),
    }),
    onSuccess: ({ run }) => {
      setFeed(initialFeedState());
      setRunId(run.id);
      cache.setQueryData(['run', run.id], run);
    },
  });
  const run = snapshot.data ?? null;

  useEffect(() => {
    if (runId === null) return;
    // Native EventSource auto-reconnects and resends the last SSE id as
    // Last-Event-ID (the global id), so the backend replays from there. Dedup on
    // id inside ingestEvent removes the replay overlap.
    const source = new EventSource(`/runs/${runId}/events`);
    source.onopen = () => setConnection('connected');
    source.onerror = () => setConnection('reconnecting…');
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as ArenaEvent;
      setFeed((current) => ingestEvent(current, event));
      cache.setQueryData<RunSnapshot>(['run', runId], (current) => projectSnapshot(current, event));
    };
    return () => source.close();
  }, [cache, runId]);

  const runLog = useMemo(() => eventsForSource(feed.events, RUN_SOURCE), [feed.events]);
  const phase = runPhase(run?.state);
  const entrants = run?.entrants ?? [];
  const connClass = connection === 'connected'
    ? 'connected'
    : connection === 'disconnected'
      ? ''
      : 'reconnecting';

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <h1 className="wordmark">
            agents<span className="spark">·</span>arena
          </h1>
          <p className="tagline">two coding agents race an on-chain ctf. one operator, live.</p>
        </div>
        <div className="link-status">
          <span className={`dot ${connClass}`} />
          <span data-testid="connection">{connection}</span>
        </div>
      </header>

      <div className="controls">
        <span className="field">
          <label htmlFor="preset">preset</label>
          <select
            id="preset"
            className="preset"
            value={preset}
            disabled={createRun.isPending}
            onChange={(event) => setPreset(event.target.value as Preset)}
          >
            {PRESETS.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </span>
        <button className="btn start" disabled={createRun.isPending} onClick={() => createRun.mutate()}>
          {createRun.isPending ? 'starting…' : 'start race'}
        </button>
        <span className="run-id">
          run <b>{run?.id ?? '—'}</b>
        </span>
      </div>

      {createRun.error instanceof Error ? <p className="error-line">{createRun.error.message}</p> : null}

      {run !== null ? (
        <div className="status-strip">
          <span className={`pill ${phase}`}>
            <span className="dot" />
            {run.state}
          </span>
          <span className="meta-count">
            <b>{feed.events.length}</b> events
          </span>
        </div>
      ) : null}

      {feed.gaps.length > 0 ? (
        <ul className="gap-banner" data-testid="gap-banner">
          {feed.gaps.map((gap, index) => (
            <li key={`${gap.source}-${gap.to}-${index}`}>
              gap in {gap.source}: seq {gap.from} → {gap.to} (events dropped)
            </li>
          ))}
        </ul>
      ) : null}

      {run === null ? (
        <div className="empty-board">
          <b>no run yet</b>
          pick a preset and start a race to watch both agents stream live.
        </div>
      ) : (
        <section className="scoreboard">
          <EntrantLane runId={run.id} entrant={entrants[0]} feed={feed} runState={run.state} startedAt={run.startedAt} side="left" />
          <div className="rail">
            <span className="vs">vs</span>
            <span className="lead">{leadLabel(entrants)}</span>
            <span className="rail-line" />
          </div>
          <EntrantLane runId={run.id} entrant={entrants[1]} feed={feed} runState={run.state} startedAt={run.startedAt} side="right" />
        </section>
      )}

      <h2 className="section-head">run log</h2>
      <ul className={`run-log${runLog.length === 0 ? ' empty' : ''}`} data-testid="run-log">
        {runLog.length === 0
          ? <li>no run-level events yet.</li>
          : runLog.map((event) => <FeedRow key={event.id} event={event} />)}
      </ul>

      <details className="raw">
        <summary>raw event log ({feed.events.length})</summary>
        <pre>{feed.events.map((event) => JSON.stringify(event)).join('\n') || 'no events.'}</pre>
      </details>
    </div>
  );
}

function leadLabel(entrants: EntrantSummary[]): string {
  if (entrants.length < 2) return '';
  const [a, b] = entrants;
  if (a.flags === b.flags) return `even · ${a.flags} flag${a.flags === 1 ? '' : 's'} each`;
  const leader = a.flags > b.flags ? a : b;
  const margin = Math.abs(a.flags - b.flags);
  return `${leader.id} leads by ${margin}`;
}

function FeedRow({ event }: { event: ArenaEvent }) {
  const style = styleForEvent(event);
  return (
    <li className={`row tone-${style.tone}`}>
      <span className="tag">{style.tag}</span>
      <span className="body">{describeEvent(event)}</span>
    </li>
  );
}

function WalletAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={copied ? 'wallet-addr copied' : 'wallet-addr'}
      title={copied ? 'copied' : `${address} · click to copy`}
      onClick={() => {
        void navigator.clipboard.writeText(address).then(() => setCopied(true));
      }}
    >
      {copied ? 'copied ✓' : truncateAddress(address)}
    </button>
  );
}

function solveTitle(solve: EntrantSolve, startedAt: string | null): string {
  const at = startedAt !== null
    ? `+${formatElapsed(startedAt, solve.ts)}`
    : new Date(solve.ts).toLocaleTimeString();
  return `challenge ${solve.challengeId} · ${at} · ${truncateAddress(solve.txHash)}`;
}

// Harnesses on a subscription login report tokens without a price, so a lane
// with no priced turn shows a dash rather than a misleading $0.00.
function formatCost(costUsd: number | null): string {
  return costUsd === null ? '—' : `$${costUsd.toFixed(costUsd < 1 ? 4 : 2)}`;
}

function formatElapsed(startedAt: string, ts: string): string {
  const totalSeconds = Math.max(0, Math.floor((new Date(ts).getTime() - new Date(startedAt).getTime()) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function EntrantLane({ runId, entrant, feed, runState, startedAt, side }: {
  runId: string;
  entrant: EntrantSummary | undefined;
  feed: FeedState;
  runState: RunState;
  startedAt: string | null;
  side: 'left' | 'right';
}) {
  const [text, setText] = useState('');
  const steer = useMutation({
    mutationFn: async (steeringText: string) => fetchJson<{ accepted: boolean }>(
      `/runs/${runId}/entrants/${entrant?.id}/steer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: steeringText }),
      },
    ),
    onSuccess: () => setText(''),
  });
  const laneEvents = useMemo(
    () => (entrant ? eventsForSource(feed.events, entrant.id) : []),
    [entrant, feed.events],
  );
  const laneGaps = useMemo(
    () => (entrant ? gapsForSource(feed.gaps, entrant.id) : []),
    [entrant, feed.gaps],
  );
  const wallet = useMemo(
    () => deriveLaneWallet(laneEvents, entrant?.address ?? null, runState),
    [laneEvents, entrant?.address, runState],
  );

  if (!entrant) return <div className="lane" />;
  const laneColor = HARNESS_COLOR[entrant.harness] ?? 'var(--muted)';

  return (
    <article
      className={`lane ${side}`}
      style={{ ['--lane' as string]: laneColor }}
    >
      <div className="lane-head">
        <h2 className="lane-name">{entrant.id}</h2>
        <span className="lane-harness">{entrant.harness}</span>
      </div>
      <p className="lane-model">{entrant.model}</p>

      {wallet.address !== null ? (
        <div className="lane-wallet" data-testid={`lane-wallet-${entrant.id}`}>
          <WalletAddress address={wallet.address} />
          {wallet.funded ? (
            <span className="wallet-fund funded" data-testid={`lane-fund-${entrant.id}`}>
              funded{wallet.wei !== null ? ` · ${formatWei(wallet.wei)} eth` : ''}
            </span>
          ) : wallet.wei !== null ? (
            <span className="wallet-fund" data-testid={`lane-fund-${entrant.id}`}>{formatWei(wallet.wei)} eth</span>
          ) : wallet.awaitingFunds ? (
            <span className="wallet-fund awaiting" data-testid={`lane-fund-${entrant.id}`}>awaiting funds</span>
          ) : null}
        </div>
      ) : null}

      <div className="lane-stats">
        <span className="stat">
          <span className={`status-tag ${entrant.status}`}>{entrant.status}</span>
        </span>
        <span className="stat flags-count">
          flags <b>{entrant.flags}</b>
        </span>
        <span className="stat">
          tokens <b>{entrant.inputTokens}</b> in / <b>{entrant.outputTokens}</b> out
        </span>
        <span className="stat" data-testid={`lane-cost-${entrant.id}`}>
          cost <b>{formatCost(entrant.costUsd)}</b>
        </span>
      </div>

      {entrant.solves.length > 0 ? (
        <ul className="lane-solves" data-testid={`lane-solves-${entrant.id}`}>
          {entrant.solves.map((solve) => (
            <li key={solve.challengeId} className="solve-chip" title={solveTitle(solve, startedAt)}>
              #{solve.challengeId}
            </li>
          ))}
        </ul>
      ) : null}

      {laneGaps.length > 0 ? (
        <p className="lane-gap" data-testid={`lane-gap-${entrant.id}`}>
          gap in {entrant.id}: {laneGaps.map((gap) => `${gap.from}→${gap.to}`).join(', ')}
        </p>
      ) : null}

      <div className="steer-row">
        <input
          className="steer"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="inject a message to this agent"
        />
        <button
          className="btn steer-btn"
          disabled={text.length === 0 || steer.isPending}
          onClick={() => steer.mutate(text)}
        >
          steer
        </button>
      </div>
      {steer.error instanceof Error ? <p className="error-line">{steer.error.message}</p> : null}

      <p className="feed-label">live feed</p>
      <ul className={`feed${laneEvents.length === 0 ? ' empty' : ''}`} data-testid={`lane-${entrant.id}`}>
        {laneEvents.length === 0
          ? <li>waiting for the agent to act…</li>
          : laneEvents.map((event) => <FeedRow key={event.id} event={event} />)}
      </ul>
    </article>
  );
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
