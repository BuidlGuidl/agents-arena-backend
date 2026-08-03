import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  ArenaEvent,
  BroadcastResponse,
  EntrantSolve,
  EntrantSummary,
  HarnessId,
  RunSnapshot,
  RunState,
} from '../../../contract/arena-types';
import { HARNESS_IDS, ROSTER_EFFORTS, ROSTER_MODELS } from '../../../contract/arena-types';
import { projectSnapshot } from './project-snapshot';
import {
  deriveLaneWallet,
  deriveWaitingRoom,
  describeEntry,
  entriesForSource,
  formatWei,
  gapsForSource,
  ingestEvent,
  initialFeedState,
  RUN_SOURCE,
  truncateAddress,
  type FeedEntry,
  type FeedState,
} from './feed-projection';
import { runPhase, styleForEntry } from './event-style';
import {
  injectedProvider,
  isWaitingRoomState,
  looksLikeSignature,
  requestSeedSignature,
  SEED_CHAIN_ID,
  seedErrorMessage,
  seedTypedData,
  walletErrorMessage,
} from './waiting-room';
import { OperatorLogin } from './operator-login';
import {
  buildRoster,
  DEFAULT_EFFORT,
  laneOrder,
  MAX_ENTRANTS,
  newDraft,
  SUBSTRATE_PRESET,
  SUBSTRATES,
  type DraftEntrant,
  type RosterDraft,
  type Substrate,
} from './roster';
import './styles.css';

const queryClient = new QueryClient();

const PRESETS = ['fake-duel', 'docker-duel', 'docker-arena'] as const;
type Preset = (typeof PRESETS)[number];

const LANE_COLORS = [
  '#f4b860',
  '#5cc8f2',
  '#b79cf0',
  '#5fd39a',
  '#f26a82',
  '#efe45c',
  '#2f9e8f',
  '#d88ad3',
  '#91c46c',
  '#ef8f62',
] as const;

function App() {
  const cache = useQueryClient();
  const [preset, setPreset] = useState<Preset>('fake-duel');
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');
  const [substrate, setSubstrate] = useState<Substrate>('fake');
  const [drafts, setDrafts] = useState<DraftEntrant[]>(() => [newDraft('codex'), newDraft('claude')]);
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
  const roster = useMemo(() => buildRoster(drafts), [drafts]);
  const createRun = useMutation({
    mutationFn: async () => fetchJson<{ run: RunSnapshot }>('/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mode === 'custom'
        ? { preset: SUBSTRATE_PRESET[substrate], autoStart: true, roster: roster.entries }
        : { preset, autoStart: true }),
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

  const runLog = useMemo(() => entriesForSource(feed.entries, RUN_SOURCE), [feed.entries]);
  const phase = runPhase(run?.state);
  const entrants = [...(run?.entrants ?? [])].sort((a, b) => a.id.localeCompare(b.id));
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
          <p className="tagline">coding agents race an on-chain ctf. one operator, live.</p>
        </div>
        <div className="link-status">
          <OperatorLogin />
          <span className={`dot ${connClass}`} />
          <span data-testid="connection">{connection}</span>
        </div>
      </header>

      <div className="controls">
        <span className="seg-group" role="group" aria-label="lineup mode">
          <button
            type="button"
            className={`seg${mode === 'preset' ? ' on' : ''}`}
            data-testid="mode-preset"
            onClick={() => setMode('preset')}
          >
            preset
          </button>
          <button
            type="button"
            className={`seg${mode === 'custom' ? ' on' : ''}`}
            data-testid="mode-custom"
            onClick={() => setMode('custom')}
          >
            custom lineup
          </button>
        </span>
        {mode === 'preset' ? (
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
        ) : (
          <span className="field">
            <label htmlFor="substrate">substrate</label>
            <select
              id="substrate"
              className="preset"
              value={substrate}
              data-testid="substrate"
              disabled={createRun.isPending}
              onChange={(event) => setSubstrate(event.target.value as Substrate)}
            >
              {SUBSTRATES.map((value) => (
                <option key={value} value={value}>
                  {value === 'fake' ? 'fake · no containers' : 'docker · real containers'}
                </option>
              ))}
            </select>
          </span>
        )}
        <button
          className="btn start"
          data-testid="start-run"
          disabled={createRun.isPending || (mode === 'custom' && roster.problem !== null)}
          onClick={() => createRun.mutate()}
        >
          {createRun.isPending ? 'starting…' : 'start race'}
        </button>
        <span className="run-id">
          run <b>{run?.id ?? '—'}</b>
        </span>
      </div>

      {mode === 'custom' ? (
        <LineupComposer
          drafts={drafts}
          roster={roster}
          disabled={createRun.isPending}
          onChange={setDrafts}
        />
      ) : null}

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

      {run !== null && isWaitingRoomState(run.state) ? <WaitingRoom run={run} feed={feed} /> : null}

      {run === null ? (
        <div className="empty-board">
          <b>no run yet</b>
          pick a preset and start a race to watch the agents stream live.
        </div>
      ) : (
        <section className={`scoreboard${entrants.length === 2 ? ' two-entrant' : ''}`}>
          {entrants.map((entrant, index) => (
            <React.Fragment key={entrant.id}>
              {index === 1 && entrants.length === 2 ? (
                <div className="rail">
                  <span className="vs">vs</span>
                  <span className="lead">{leadLabel(entrants)}</span>
                  <span className="rail-line" />
                </div>
              ) : null}
              <EntrantLane
                runId={run.id}
                entrant={entrant}
                feed={feed}
                runState={run.state}
                startedAt={run.startedAt}
                laneColor={LANE_COLORS[index] ?? 'var(--muted)'}
              />
            </React.Fragment>
          ))}
        </section>
      )}

      {run !== null ? (
        <>
          <h2 className="section-head">director</h2>
          <BroadcastRow key={run.id} runId={run.id} />
        </>
      ) : null}

      <h2 className="section-head">run log</h2>
      <ul className={`run-log${runLog.length === 0 ? ' empty' : ''}`} data-testid="run-log">
        {runLog.length === 0
          ? <li>no run-level events yet.</li>
          : runLog.map((entry) => <FeedRow key={entry.event.id} entry={entry} />)}
      </ul>

      <details className="raw">
        <summary>raw event log ({feed.events.length})</summary>
        <pre>{feed.events.map((event) => JSON.stringify(event)).join('\n') || 'no events.'}</pre>
      </details>
    </div>
  );
}

// Builds the roster the run starts with. Lane names are generated and models come
// from the contract's allowlist, so every row is valid by construction.
function LineupComposer({ drafts, roster, disabled, onChange }: {
  drafts: DraftEntrant[];
  roster: RosterDraft;
  disabled: boolean;
  onChange: (drafts: DraftEntrant[]) => void;
}) {
  const update = (index: number, next: DraftEntrant) => {
    onChange(drafts.map((draft, at) => (at === index ? next : draft)));
  };
  const lanes = laneOrder(roster.entries);

  return (
    <section className="lineup" data-testid="lineup">
      <ul className="lineup-rows">
        {drafts.map((draft, index) => {
          const id = roster.entries[index].id;
          const models = ROSTER_MODELS[draft.harness];
          return (
            <li
              className="lineup-row"
              key={index}
              data-testid={`lineup-row-${index}`}
              style={{ ['--lane' as string]: LANE_COLORS[lanes[index]] ?? 'var(--muted)' }}
            >
              <span className="lineup-id" data-testid={`lineup-id-${index}`}>{id}</span>
              <select
                className="preset pick"
                aria-label={`harness for ${id}`}
                data-testid={`harness-${index}`}
                value={draft.harness}
                disabled={disabled}
                onChange={(event) => update(index, newDraft(event.target.value as HarnessId))}
              >
                {HARNESS_IDS.map((harness) => (
                  <option key={harness} value={harness}>{harness}</option>
                ))}
              </select>
              <select
                className="preset pick model"
                aria-label={`model for ${id}`}
                data-testid={`model-${index}`}
                value={draft.model}
                disabled={disabled}
                onChange={(event) => update(index, { ...draft, model: event.target.value })}
              >
                {models.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
              {draft.harness === 'codex' ? (
                <span className="field lineup-effort">
                  <label htmlFor={`effort-${index}`}>effort</label>
                  <select
                    id={`effort-${index}`}
                    className="preset pick"
                    data-testid={`effort-${index}`}
                    value={draft.effort}
                    disabled={disabled}
                    onChange={(event) => update(index, {
                      ...draft,
                      effort: event.target.value as DraftEntrant['effort'],
                    })}
                  >
                    <option value={DEFAULT_EFFORT}>{DEFAULT_EFFORT}</option>
                    {ROSTER_EFFORTS.map((effort) => (
                      <option key={effort} value={effort}>{effort}</option>
                    ))}
                  </select>
                </span>
              ) : null}
              <button
                type="button"
                className="btn row-btn"
                data-testid={`remove-${index}`}
                disabled={disabled || drafts.length === 1}
                title={drafts.length === 1 ? 'a run needs one entrant' : `remove ${id}`}
                onClick={() => onChange(drafts.filter((_, at) => at !== index))}
              >
                remove
              </button>
            </li>
          );
        })}
      </ul>

      <div className="lineup-foot">
        <button
          type="button"
          className="btn row-btn add"
          data-testid="add-entrant"
          disabled={disabled || drafts.length >= MAX_ENTRANTS}
          onClick={() => onChange([...drafts, newDraft('codex')])}
        >
          add entrant
        </button>
        <span className="lineup-count">
          <b>{drafts.length}</b> of {MAX_ENTRANTS} lanes
        </span>
      </div>

      {roster.problem !== null ? (
        <p className="error-line lineup-problem" data-testid="lineup-problem">{roster.problem}</p>
      ) : null}

      <p className="lineup-note">
        the model list is server-enforced. effort is a codex knob, so only codex rows carry it.
      </p>
    </section>
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

// One message to the whole arena. The broadcast event itself arrives over SSE and
// renders in the run log below, so this only reports who took the turn — a lane
// that could not be reached is named here and nowhere else.
function BroadcastRow({ runId }: { runId: string }) {
  const [text, setText] = useState('');
  const broadcast = useMutation({
    mutationFn: async (message: string) => fetchJson<BroadcastResponse>(`/runs/${runId}/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    }),
    onSuccess: () => setText(''),
  });
  const result = broadcast.data;

  return (
    <div>
      <div className="steer-row">
        <input
          className="steer"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="say something to every live agent at once"
        />
        <button
          className="btn steer-btn"
          disabled={text.length === 0 || broadcast.isPending}
          onClick={() => broadcast.mutate(text)}
        >
          {broadcast.isPending ? 'sending…' : 'broadcast'}
        </button>
      </div>
      {broadcast.error instanceof Error ? <p className="error-line">{broadcast.error.message}</p> : null}
      {result !== undefined ? (
        <p className="broadcast-result" data-testid="broadcast-result">
          sent to {result.delivered.length > 0 ? result.delivered.join(', ') : 'nobody'}
          {result.failed.map((entry) => ` · ${entry.entrantId} missed it (${entry.message})`).join('')}
        </p>
      ) : null}
    </div>
  );
}

function FeedRow({ entry }: { entry: FeedEntry }) {
  const style = styleForEntry(entry);
  return (
    <li className={`row tone-${style.tone}`}>
      <span className="tag">{style.tag}</span>
      <span className="body">{describeEntry(entry)}</span>
    </li>
  );
}

// Flashes a "copied" state for a beat after the clipboard write resolves.
function useCopyFlag(): [boolean, (value: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(() => setCopied(true));
  };
  return [copied, copy];
}

function WalletAddress({ address, full = false }: { address: string; full?: boolean }) {
  const [copied, copy] = useCopyFlag();
  return (
    <button
      type="button"
      className={copied ? 'wallet-addr copied' : 'wallet-addr'}
      title={copied ? 'copied' : `${address} · click to copy`}
      onClick={() => copy(address)}
    >
      {copied ? 'copied ✓' : full ? address : truncateAddress(address)}
    </button>
  );
}

// The pre-race panel. Two states share it: `awaiting_signature`, where the
// funder signs the seed typed data, and `awaiting_funding`, where they send ETH to
// the addresses that signature derived. Presentation stays deliberately plain —
// blockies, explorer links, and multisend belong to the real frontend.
function WaitingRoom({ run, feed }: { run: RunSnapshot; feed: FeedState }) {
  const cache = useQueryClient();
  const [pasted, setPasted] = useState('');
  const [walletError, setWalletError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [typedDataCopied, copyTypedData] = useCopyFlag();

  const typedData = seedTypedData(run.id, SEED_CHAIN_ID);
  const typedDataJson = JSON.stringify(typedData);
  const provider = injectedProvider();
  const roster = useMemo(
    () => deriveWaitingRoom(run.entrants, feed.entries, run.state),
    [run.entrants, run.state, feed.entries],
  );

  const seed = useMutation({
    mutationFn: async (signature: string) => {
      const response = await fetch(`/runs/${run.id}/seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature }),
      });
      if (!response.ok) throw new Error(seedErrorMessage(response.status));
      return response.json() as Promise<{ run: RunSnapshot }>;
    },
    onSuccess: ({ run: seeded }) => {
      setPasted('');
      // Same rule as the snapshot query: the SSE projection can already be past
      // this response, so the higher lastEventId wins.
      cache.setQueryData<RunSnapshot>(['run', run.id], (current) => (
        current !== undefined && current.lastEventId > seeded.lastEventId ? current : seeded
      ));
    },
  });

  const signAndSubmit = async () => {
    if (provider === undefined) return;
    setWalletError(null);
    setSigning(true);
    try {
      seed.mutate(await requestSeedSignature(provider, typedData));
    } catch (error) {
      setWalletError(walletErrorMessage(error));
    } finally {
      setSigning(false);
    }
  };

  const busy = signing || seed.isPending;

  return (
    <section className="waiting-room" data-testid="waiting-room">
      <h2 className="section-head">waiting room</h2>

      {run.state === 'awaiting_signature' ? (
        <div className="seed-panel">
          <p className="seed-run">
            run <b>{run.id}</b>
          </p>
          <p className="seed-hint">
            the funder signs this typed data once. the arena derives every burner wallet from the
            signature and keeps no key.
          </p>
          <div className="seed-msg">
            <pre data-testid="seed-typed-data">{typedDataJson}</pre>
            <button
              type="button"
              className="btn copy-btn"
              onClick={() => copyTypedData(typedDataJson)}
            >
              {typedDataCopied ? 'copied ✓' : 'copy typed data'}
            </button>
          </div>

          {provider !== undefined ? (
            <button
              className="btn sign"
              data-testid="sign-button"
              disabled={busy}
              onClick={() => void signAndSubmit()}
            >
              {busy ? 'signing…' : 'sign with wallet'}
            </button>
          ) : null}
          <p className="seed-hint">
            {provider === undefined
              ? 'no injected wallet here. sign the typed data above with cast wallet sign --data, then paste the signature.'
              : 'if wallet signing fails, sign the typed data with cast wallet sign --data, then paste the signature.'}
          </p>
          <div className="seed-paste">
            <input
              className="steer"
              data-testid="signature-input"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder="0x… 65-byte signature"
            />
            <button
              className="btn steer-btn"
              disabled={!looksLikeSignature(pasted) || seed.isPending}
              onClick={() => seed.mutate(pasted.trim())}
            >
              {seed.isPending ? 'submitting…' : 'submit signature'}
            </button>
          </div>

          {walletError !== null ? <p className="error-line">{walletError}</p> : null}
          {seed.error instanceof Error ? (
            <p className="error-line" data-testid="seed-error">{seed.error.message}</p>
          ) : null}
        </div>
      ) : (
        <p className="seed-hint">
          send ETH to each address below. the gate watches balances, so a top-up to the same
          address counts too.
        </p>
      )}

      <ul className="roster" data-testid="waiting-roster">
        {roster.map((entry) => (
          <li className="roster-row" key={entry.entrantId} data-testid={`roster-${entry.entrantId}`}>
            <span className="roster-name">{entry.entrantId}</span>
            {entry.address !== null
              ? <WalletAddress address={entry.address} full />
              : <span className="roster-pending">address arrives with the signature</span>}
            <span
              className={`wallet-fund ${entry.status === 'funded' ? 'funded' : 'awaiting'}`}
              data-testid={`roster-fund-${entry.entrantId}`}
            >
              {rosterFundLabel(entry.status, entry.wei)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function rosterFundLabel(status: 'pending' | 'waiting' | 'funded', wei: string | null): string {
  if (status === 'pending') return '—';
  const balance = wei !== null ? ` · ${formatWei(wei)} eth` : '';
  return `${status === 'funded' ? 'funded' : 'waiting'}${balance}`;
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

function EntrantLane({ runId, entrant, feed, runState, startedAt, laneColor }: {
  runId: string;
  entrant: EntrantSummary;
  feed: FeedState;
  runState: RunState;
  startedAt: string | null;
  laneColor: string;
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
  const laneEntries = useMemo(
    () => (entrant ? entriesForSource(feed.entries, entrant.id) : []),
    [entrant, feed.entries],
  );
  const laneEvents = useMemo(() => laneEntries.map((entry) => entry.event), [laneEntries]);
  const laneGaps = useMemo(
    () => (entrant ? gapsForSource(feed.gaps, entrant.id) : []),
    [entrant, feed.gaps],
  );
  const wallet = useMemo(
    () => deriveLaneWallet(laneEvents, entrant?.address ?? null, runState),
    [laneEvents, entrant?.address, runState],
  );

  return (
    <article
      className="lane"
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
      <ul className={`feed${laneEntries.length === 0 ? ' empty' : ''}`} data-testid={`lane-${entrant.id}`}>
        {laneEntries.length === 0
          ? <li>waiting for the agent to act…</li>
          : laneEntries.map((entry) => <FeedRow key={entry.event.id} entry={entry} />)}
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
