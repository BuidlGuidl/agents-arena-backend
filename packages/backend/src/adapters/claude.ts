import type { EventJournal } from '../journal.js';
import type { EntrantContainer } from '../runtime/container.js';
import { getWallet } from '../chain/wallet.js';
import { ClaudeEventParser } from './claude-parser.js';
import { registerCredentialSecrets } from './credential-secrets.js';
import {
  HarnessEntrantDriver,
  type HarnessDriverOptions,
} from './harness-driver.js';
import type { EntrantRecord, RunRecord } from './types.js';

export interface ClaudeDriverOptions extends HarnessDriverOptions {
  oauthToken?: string;
  turnWatchdogMs?: number;
}

export class ClaudeDriver extends HarnessEntrantDriver {
  private readonly oauthToken: string | undefined;
  private readonly turnTimeout: number;

  constructor(journal: EventJournal, options: ClaudeDriverOptions = {}) {
    super(journal, options);
    this.oauthToken = options.oauthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
    this.turnTimeout = options.turnWatchdogMs ?? 10 * 60 * 1_000;
  }

  protected harnessName(): string {
    return 'claude';
  }

  protected assertHarness(entrant: EntrantRecord): void {
    if (entrant.harness !== 'claude') {
      throw new Error(`ClaudeDriver cannot run harness ${entrant.harness}`);
    }
  }

  protected async createContainer(run: RunRecord, entrant: EntrantRecord): Promise<EntrantContainer> {
    const oauthToken = this.oauthToken;
    if (oauthToken === undefined || oauthToken.length === 0) {
      throw new Error('Claude OAuth token not found in CLAUDE_CODE_OAUTH_TOKEN');
    }
    registerCredentialSecrets(run.id, [oauthToken]);
    const wallet = getWallet(run.id, entrant.id);
    return this.containerFactory({
      runId: run.id,
      entrantId: entrant.id,
      credentialFiles: [{ path: '/creds/claude' }],
      // Claude checks ANTHROPIC_API_KEY first, so a stray API key silently overrides the subscription token.
      env: {
        CLAUDE_CONFIG_DIR: '/creds/claude',
        CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
        ETH_RPC_URL: this.rpcUrl,
        ...(wallet === null
          ? {}
          : {
            WALLET_ADDRESS: wallet.address,
            WALLET_PRIVATE_KEY: wallet.privateKey,
          }),
      },
    });
  }

  protected versionArgv(): string[] {
    return ['claude', '--version'];
  }

  protected startArgv(entrant: EntrantRecord, prompt: string): string[] {
    return [
      'claude',
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--model',
      entrant.model,
    ];
  }

  protected resumeArgv(entrant: EntrantRecord, sessionId: string, text: string): string[] {
    return [
      'claude',
      '-p',
      '--resume',
      sessionId,
      text,
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--model',
      entrant.model,
    ];
  }

  protected createParser(entrant: EntrantRecord): ClaudeEventParser {
    return new ClaudeEventParser(entrant.id, entrant.model, this.logger);
  }

  protected watchdogMs(): number {
    return this.turnTimeout;
  }

  protected validateResumeSession(): boolean {
    return true;
  }
}
