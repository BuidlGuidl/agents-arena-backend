import type { ChallengePackAccess, ChallengePackResolver } from '../ctf/resolve.js';
import type { SteerDelivery } from '../contract.js';
import type { EventJournal } from '../journal.js';
import { ClaudeDriver, type ClaudeDriverOptions } from './claude.js';
import { CodexDriver, type CodexDriverOptions } from './codex.js';
import { OpenCodeDriver, type OpenCodeDriverOptions } from './opencode.js';
import type { EntrantDriver, EntrantRecord, RunRecord } from './types.js';

export interface DockerEntrantDriverOptions {
  claude?: ClaudeDriverOptions;
  codex?: CodexDriverOptions;
  opencode?: OpenCodeDriverOptions;
  resolveChallengePack?: ChallengePackResolver;
  challengeAddresses?: ChallengePackAccess['addressesFor'];
}

export class DockerEntrantDriver implements EntrantDriver {
  private readonly claude: ClaudeDriver;
  private readonly codex: CodexDriver;
  private readonly opencode: OpenCodeDriver;

  constructor(journal: EventJournal, options: DockerEntrantDriverOptions = {}) {
    // Every entrant reads the same pack, so the resolver is shared unless a
    // per-harness option overrides it.
    const shared = {
      ...(options.resolveChallengePack === undefined
        ? {}
        : { resolveChallengePack: options.resolveChallengePack }),
      ...(options.challengeAddresses === undefined
        ? {}
        : { challengeAddresses: options.challengeAddresses }),
    };
    this.claude = new ClaudeDriver(journal, { ...shared, ...options.claude });
    this.codex = new CodexDriver(journal, { ...shared, ...options.codex });
    this.opencode = new OpenCodeDriver(journal, { ...shared, ...options.opencode });
  }

  async prepare(run: RunRecord, entrant: EntrantRecord): Promise<void> {
    await this.driver(entrant).prepare(run, entrant);
  }

  async start(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void> {
    await this.driver(entrant).start(run, entrant, openingPrompt);
  }

  async steer(run: RunRecord, entrant: EntrantRecord, text: string): Promise<SteerDelivery> {
    return this.driver(entrant).steer(run, entrant, text);
  }

  async restart(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void> {
    await this.driver(entrant).restart(run, entrant, openingPrompt);
  }

  async stop(run: RunRecord, entrant: EntrantRecord): Promise<void> {
    await this.driver(entrant).stop(run, entrant);
  }

  private driver(entrant: EntrantRecord): EntrantDriver {
    if (entrant.harness === 'claude') return this.claude;
    if (entrant.harness === 'codex') return this.codex;
    if (entrant.harness === 'opencode') return this.opencode;
    throw new Error(`Docker driver does not support harness ${entrant.harness}`);
  }
}
