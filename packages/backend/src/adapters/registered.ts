import { activeChainProfile } from '../chain/profile.js';
import type { SteerDelivery } from '../contract.js';
import { createChallengePackResolver } from '../ctf/resolve.js';
import type { EventJournal } from '../journal.js';
import { presetSubstrate, UnknownPresetError } from '../run-manager.js';
import { DockerEntrantDriver } from './docker.js';
import { FakeDriver, type Schedule } from './fake.js';
import type { EntrantDriver, EntrantRecord, RunRecord } from './types.js';

export class RegisteredEntrantDriver implements EntrantDriver {
  private readonly fake: FakeDriver;
  private readonly docker: DockerEntrantDriver;

  constructor(journal: EventJournal, schedule?: Schedule) {
    this.fake = new FakeDriver(journal, schedule);
    // Same profile the funding gate and the opening prompt read. A profile with
    // a briefing URL resolves to undefined and mounts nothing (ADR-0009).
    const pack = createChallengePackResolver(activeChainProfile);
    this.docker = new DockerEntrantDriver(
      journal,
      pack === undefined
        ? {}
        : { resolveChallengePack: pack.resolve, challengeAddresses: pack.addressesFor },
    );
  }

  async prepare(run: RunRecord, entrant: EntrantRecord): Promise<void> {
    await this.driver(run).prepare(run, entrant);
  }

  async start(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void> {
    await this.driver(run).start(run, entrant, openingPrompt);
  }

  async steer(run: RunRecord, entrant: EntrantRecord, text: string): Promise<SteerDelivery> {
    return this.driver(run).steer(run, entrant, text);
  }

  async restart(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void> {
    await this.driver(run).restart(run, entrant, openingPrompt);
  }

  async stop(run: RunRecord, entrant: EntrantRecord): Promise<void> {
    await this.driver(run).stop(run, entrant);
  }

  private driver(run: RunRecord): EntrantDriver {
    try {
      return presetSubstrate(run.preset) === 'docker' ? this.docker : this.fake;
    } catch (error) {
      if (!(error instanceof UnknownPresetError)) throw error;
      // Unknown legacy presets use Docker so real containers get torn down; its harness drivers no-op if the entrant was never started.
      return this.docker;
    }
  }
}
