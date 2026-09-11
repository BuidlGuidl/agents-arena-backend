import type { AgentOption, HarnessId, RosterEffort, RosterEntry } from '../../../contract/arena-types';

export const MAX_ENTRANTS = 10;

export const SUBSTRATES = ['fake', 'docker'] as const;
export type Substrate = (typeof SUBSTRATES)[number];

// A roster replaces the preset's entrants, so with one attached the preset only
// carries the substrate: fake harnesses or real containers.
export const SUBSTRATE_PRESET: Record<Substrate, string> = {
  fake: 'fake-duel',
  docker: 'docker-arena',
};

export interface DraftEntrant {
  harness: HarnessId;
  model: string;
  effort: RosterEffort;
}

export interface RosterDraft {
  entries: RosterEntry[];
  problem: string | null;
}

export function newDraft(harness: HarnessId, agents: readonly AgentOption[]): DraftEntrant | null {
  const agent = agents.find((entry) => entry.harness === harness);
  if (!agent || !agent.efforts[0]) return null;
  return { harness, model: agent.model, effort: agent.efforts[0] };
}

// codex-1, codex-2, claude-1 … numbered per harness in row order, so a row's
// lane name only shifts when the rows above it change.
export function assignIds(drafts: readonly DraftEntrant[]): string[] {
  const seen = new Map<HarnessId, number>();
  return drafts.map((draft) => {
    const next = (seen.get(draft.harness) ?? 0) + 1;
    seen.set(draft.harness, next);
    return `${draft.harness}-${next}`;
  });
}

// The board sorts entrants by id and colours lanes by that position, so a row can
// preview the colour its lane will actually get.
export function laneOrder(entries: readonly RosterEntry[]): number[] {
  const sorted = [...entries].map((entry) => entry.id).sort((a, b) => a.localeCompare(b));
  return entries.map((entry) => sorted.indexOf(entry.id));
}

// Catch invalid entries before the create request so the row can show the reason.
export function buildRoster(drafts: readonly DraftEntrant[], agents: readonly AgentOption[]): RosterDraft {
  const ids = assignIds(drafts);
  const entries = drafts.map((draft, index) => ({ id: ids[index], ...draft }));
  return { entries, problem: rosterProblem(entries, agents) };
}

function rosterProblem(entries: readonly RosterEntry[], agents: readonly AgentOption[]): string | null {
  if (entries.length === 0) return 'add at least one entrant.';
  if (entries.length > MAX_ENTRANTS) return `${MAX_ENTRANTS} entrants max.`;
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    return 'two entrants share a lane name.';
  }
  for (const entry of entries) {
    const problem = entryProblem(entry, agents);
    if (problem !== null) return problem;
  }
  return null;
}

function entryProblem(entry: RosterEntry, agents: readonly AgentOption[]): string | null {
  if (entry.id.length > 20 || !/^[a-z][a-z0-9-]*$/.test(entry.id) || entry.id === 'run') {
    return `${entry.id} is not a usable lane name.`;
  }
  const agent = agents.find((agent) => agent.harness === entry.harness && agent.model === entry.model);
  if (!agent) {
    return `${entry.id}: ${entry.harness} does not run ${entry.model}.`;
  }
  if (!agent.efforts.includes(entry.effort)) {
    return `${entry.id}: ${entry.model} accepts effort ${agent.efforts.join(', ')}.`;
  }
  return null;
}
