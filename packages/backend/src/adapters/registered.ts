import { activeChainProfile } from '../chain/profile.js';
import type { SteerDelivery } from '../contract.js';
import { createChallengePackResolver, type ChallengePackAccess } from '../ctf/resolve.js';
import type { EventJournal } from '../journal.js';
import { presetSubstrate, UnknownPresetError } from '../run-manager.js';
import type { ExternalStatus } from './external-status.js';
import { ExternalDriver } from './external.js';
import { DockerEntrantDriver } from './docker.js';
import { FakeDriver, type Schedule } from './fake.js';
import type { EntrantDriver, EntrantRecord, RunRecord } from './types.js';

interface RegisteredEntrantDriverOptions {
  status: ExternalStatus;
  schedule?: Schedule | undefined;
  hosted?: EntrantDriver;
  pack?: ChallengePackAccess;
}

export class RegisteredEntrantDriver implements EntrantDriver {
  private readonly external: ExternalDriver;
  private readonly fake: FakeDriver;
  private readonly docker: DockerEntrantDriver;

  constructor(
    journal: EventJournal,
    private readonly options: RegisteredEntrantDriverOptions,
  ) {
    this.external = new ExternalDriver(journal, options.status);
    this.fake = new FakeDriver(journal, options.schedule);
    // Same profile the funding gate and the opening prompt read. A profile with
    // a briefing URL has no resolver and mounts nothing (ADR-0009).
    const pack = options.pack ?? createChallengePackResolver(activeChainProfile);
    this.docker = new DockerEntrantDriver(
      journal,
      {
        ...(pack.resolve === undefined ? {} : { resolveChallengePack: pack.resolve }),
        challengeAddresses: pack.addressesFor,
      },
    );
  }

  async prepare(run: RunRecord, entrant: EntrantRecord): Promise<void> {
    await this.driver(run, entrant).prepare(run, entrant);
  }

  async start(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void> {
    await this.driver(run, entrant).start(run, entrant, openingPrompt);
  }

  async steer(run: RunRecord, entrant: EntrantRecord, text: string, origin: 'steer' | 'broadcast' = 'steer'): Promise<SteerDelivery> {
    return this.driver(run, entrant).steer(run, entrant, text, origin);
  }

  async restart(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void> {
    await this.driver(run, entrant).restart(run, entrant, openingPrompt);
  }

  async stop(run: RunRecord, entrant: EntrantRecord): Promise<void> {
    await this.driver(run, entrant).stop(run, entrant);
  }

  private driver(run: RunRecord, entrant: EntrantRecord): EntrantDriver {
    if (entrant.kind === 'external') return this.external;
    if (this.options.hosted !== undefined) return this.options.hosted;
    try {
      return presetSubstrate(run.preset) === 'docker' ? this.docker : this.fake;
    } catch (error) {
      if (!(error instanceof UnknownPresetError)) throw error;
      // Unknown legacy presets use Docker so real containers get torn down; its harness drivers no-op if the entrant was never started.
      return this.docker;
    }
  }
}
