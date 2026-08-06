import { ROSTER_MODELS } from '../../../contract/arena-types';
import type { HarnessId, RosterEffort, RosterEntry } from '../../../contract/arena-types';

export const MAX_ENTRANTS = 10;

// Sits in the effort select ahead of the real levels. It means "send no effort
// field", which is not the same as any level the harness names.
export const DEFAULT_EFFORT = 'default';

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
  effort: RosterEffort | typeof DEFAULT_EFFORT;
}

export interface RosterDraft {
  entries: RosterEntry[];
  problem: string | null;
}

export function newDraft(harness: HarnessId): DraftEntrant {
  return { harness, model: ROSTER_MODELS[harness][0], effort: DEFAULT_EFFORT };
}

// This gate mirrors the backend rule so OpenCode rows cannot carry effort into
// the request. The default sentinel omits the field and preserves harness defaults.
export function draftEffort(draft: DraftEntrant): RosterEffort | undefined {
  if (draft.harness === 'opencode' || draft.effort === DEFAULT_EFFORT) return undefined;
  return draft.effort;
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

// Mirrors the backend's create-run schema so a bad lineup reads as an inline
// reason instead of a 400.
export function buildRoster(drafts: readonly DraftEntrant[]): RosterDraft {
  const ids = assignIds(drafts);
  const entries = drafts.map((draft, index) => {
    const effort = draftEffort(draft);
    return {
      id: ids[index],
      harness: draft.harness,
      model: draft.model,
      ...(effort === undefined ? {} : { effort }),
    };
  });
  return { entries, problem: rosterProblem(entries) };
}

function rosterProblem(entries: readonly RosterEntry[]): string | null {
  if (entries.length === 0) return 'add at least one entrant.';
  if (entries.length > MAX_ENTRANTS) return `${MAX_ENTRANTS} entrants max.`;
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    return 'two entrants share a lane name.';
  }
  for (const entry of entries) {
    const problem = entryProblem(entry);
    if (problem !== null) return problem;
  }
  return null;
}

function entryProblem(entry: RosterEntry): string | null {
  if (entry.id.length > 20 || !/^[a-z][a-z0-9-]*$/.test(entry.id) || entry.id === 'run') {
    return `${entry.id} is not a usable lane name.`;
  }
  if (!ROSTER_MODELS[entry.harness].includes(entry.model)) {
    return `${entry.id}: ${entry.harness} does not run ${entry.model}.`;
  }
  return null;
}
