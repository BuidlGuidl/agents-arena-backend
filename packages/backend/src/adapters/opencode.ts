import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { issueAgentToken } from '../agent-auth.js';
import type { EventJournal } from '../journal.js';
import type { EntrantContainer } from '../runtime/container.js';
import { getWallet } from '../chain/wallet.js';
import {
  HarnessEntrantDriver,
  type HarnessDriverOptions,
} from './harness-driver.js';
import { registerCredentialSecrets } from './credential-secrets.js';
import { OpenCodeEventParser } from './opencode-parser.js';
import type { EntrantRecord, RunRecord } from './types.js';

export interface OpenCodeDriverOptions extends HarnessDriverOptions {
  apiKey?: string;
  authPath?: string;
  turnWatchdogMs?: number;
}

export class OpenCodeDriver extends HarnessEntrantDriver {
  private readonly apiKey: string | undefined;
  private readonly authPath: string;
  private readonly turnTimeout: number;

  constructor(journal: EventJournal, options: OpenCodeDriverOptions = {}) {
    super(journal, options);
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.authPath = options.authPath ?? join(homedir(), '.local', 'share', 'opencode', 'auth.json');
    this.turnTimeout = options.turnWatchdogMs ?? 10 * 60 * 1_000;
  }

  protected harnessName(): string {
    return 'opencode';
  }

  protected assertHarness(entrant: EntrantRecord): void {
    if (entrant.harness !== 'opencode') {
      throw new Error(`OpenCodeDriver cannot run harness ${entrant.harness}`);
    }
  }

  protected async createContainer(run: RunRecord, entrant: EntrantRecord): Promise<EntrantContainer> {
    const wallet = getWallet(run.id, entrant.id);
    const apiKey = this.apiKey ?? await readOpenRouterKey(this.authPath);
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(`OpenRouter API key not found in OPENROUTER_API_KEY or ${this.authPath}`);
    }
    registerCredentialSecrets(run.id, [apiKey]);
    const config = entrant.effort === null
      ? undefined
      : `${JSON.stringify({
        provider: {
          openrouter: {
            models: {
              [entrant.model.replace(/^openrouter\//, '')]: {
                options: { reasoningEffort: entrant.effort },
              },
            },
          },
        },
      }, null, 2)}\n`;
    return this.containerFactory({
      runId: run.id,
      entrantId: entrant.id,
      ...(config === undefined ? {} : {
        credentialFiles: [{ path: '/work/opencode.json', content: config, mode: 0o644 }],
      }),
      env: scrubOpenCodeEnvironment({
        OPENROUTER_API_KEY: apiKey,
        ETH_RPC_URL: this.rpcUrl,
        ARENA_API_URL: this.agentApiUrl,
        ARENA_AGENT_TOKEN: issueAgentToken(run.id, entrant.id),
        ...(wallet === null
          ? {}
          : {
            WALLET_ADDRESS: wallet.address,
            WALLET_PRIVATE_KEY: wallet.privateKey,
          }),
      }),
    });
  }

  protected versionArgv(): string[] {
    return ['opencode', '--version'];
  }

  protected startArgv(entrant: EntrantRecord, prompt: string): string[] {
    return ['opencode', 'run', '--format', 'json', '--auto', '-m', entrant.model, prompt];
  }

  protected resumeArgv(_entrant: EntrantRecord, sessionId: string, text: string): string[] {
    return ['opencode', 'run', '--format', 'json', '--auto', '-s', sessionId, text];
  }

  protected createParser(entrant: EntrantRecord): OpenCodeEventParser {
    return new OpenCodeEventParser(entrant.id, this.logger);
  }

  protected watchdogMs(): number {
    return this.turnTimeout;
  }
}

export function scrubOpenCodeEnvironment(environment: Record<string, string>): Record<string, string> {
  const scrubbed = { ...environment };
  delete scrubbed.OPENCODE_SERVER_PASSWORD;
  delete scrubbed.OPENCODE_PORT;
  return scrubbed;
}

export async function readOpenRouterKey(path: string): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const providers = parsed as Record<string, unknown>;
  const provider = Object.entries(providers).find(([name]) => name.toLowerCase() === 'openrouter')?.[1];
  if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) return undefined;
  const key = (provider as Record<string, unknown>).key;
  return typeof key === 'string' ? key : undefined;
}
