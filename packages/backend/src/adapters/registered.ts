import { activeChainProfile } from '../chain/profile.js';
import type { SteerDelivery } from '../contract.js';
import { createChallengePackResolver, type ChallengePackAccess } from '../ctf/resolve.js';
import type { EventJournal } from '../journal.js';
import { presetSubstrate, UnknownPresetError } from '../run-manager.js';
import { ExternalDriver } from './external.js';
import type { ExternalAgentTokens } from '../agent-auth.js';
import { DockerEntrantDriver } from './docker.js';
import { FakeDriver, type Schedule } from './fake.js';
import type { EntrantDriver, EntrantRecord, RunRecord } from './types.js';

export class RegisteredEntrantDriver implements EntrantDriver {
  private readonly external: ExternalDriver;
  private readonly fake: FakeDriver;
  private readonly docker: DockerEntrantDriver;

  constructor(
    journal: EventJournal,
    schedule?: Schedule,
    tokens?: ExternalAgentTokens,
    private readonly hosted?: EntrantDriver,
    pack: ChallengePackAccess = createChallengePackResolver(activeChainProfile),
  ) {
    this.external = new ExternalDriver(journal, tokens, schedule === undefined ? {} : { schedule });
    this.fake = new FakeDriver(journal, schedule);
    // Same profile the funding gate and the opening prompt read. A profile with
    // a briefing URL has no resolver and mounts nothing (ADR-0009).
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
    if (this.hosted !== undefined) return this.hosted;
    try {
      return presetSubstrate(run.preset) === 'docker' ? this.docker : this.fake;
    } catch (error) {
      if (!(error instanceof UnknownPresetError)) throw error;
      // Unknown legacy presets use Docker so real containers get torn down; its harness drivers no-op if the entrant was never started.
      return this.docker;
    }
  }
}
