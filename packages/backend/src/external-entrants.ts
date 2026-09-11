import { and, eq } from 'drizzle-orm';

import type { ExternalEntrantRecord, EntrantRecord } from './adapters/types.js';
import type { ArenaDatabase } from './db/index.js';
import { entrants, externalEntrants } from './db/schema.js';

export class ExternalEntrants {
  constructor(private readonly database: ArenaDatabase) {}

  register(entrant: ExternalEntrantRecord): void {
    if (entrant.address === null) throw new Error('External entrant needs a wallet address');
    const values = {
      runId: entrant.runId, id: entrant.id, address: entrant.address, name: entrant.name,
      harness: entrant.harness ?? null, model: entrant.model ?? null,
      effort: entrant.effort ?? null, url: entrant.url ?? null,
      flagsBeforeJoin: entrant.flagsBeforeJoin, joinedAt: entrant.joinedAt,
      removedAt: entrant.removedAt,
    };
    this.database.insert(externalEntrants).values(values).onConflictDoUpdate({
      target: [externalEntrants.runId, externalEntrants.id], set: values,
    }).run();
  }

  markRemoved(runId: string, id: string, removedAt: string): void {
    this.database.update(externalEntrants).set({ removedAt })
      .where(and(eq(externalEntrants.runId, runId), eq(externalEntrants.id, id))).run();
  }
}

export function toEntrantRecord({ entrants: row, external_entrants: external }: {
  entrants: typeof entrants.$inferSelect;
  external_entrants: typeof externalEntrants.$inferSelect | null;
}): EntrantRecord {
  if (row.kind === 'hosted') {
    if (row.harness === null || row.model === null) throw new Error(`Hosted entrant ${row.id} has no harness or model`);
    return { ...row, kind: 'hosted', harness: row.harness, model: row.model };
  }
  if (external === null) throw new Error(`External entrant ${row.id} has no registration`);
  return {
    runId: row.runId, id: row.id, kind: 'external', status: row.status,
    address: external.address, name: external.name, joinedAt: external.joinedAt,
    removedAt: external.removedAt, flagsBeforeJoin: external.flagsBeforeJoin,
    ...declaredFields(external),
  };
}

export function declaredFields(input: {
  harness?: string | null | undefined;
  model?: string | null | undefined;
  effort?: string | null | undefined;
  url?: string | null | undefined;
}) {
  return {
    ...(input.harness == null ? {} : { harness: input.harness }),
    ...(input.model == null ? {} : { model: input.model }),
    ...(input.effort == null ? {} : { effort: input.effort }),
    ...(input.url == null ? {} : { url: input.url }),
  };
}
