import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { EventJournal } from '../journal.js';
import type { EntrantContainer } from '../runtime/container.js';
import { getWallet } from '../chain/wallet.js';
import { CodexEventParser } from './codex-parser.js';
import { registerCredentialSecrets } from './credential-secrets.js';
import {
  HarnessEntrantDriver,
  type HarnessDriverOptions,
} from './harness-driver.js';
import type { EntrantRecord, RunRecord } from './types.js';

export interface CodexDriverOptions extends HarnessDriverOptions {
  authPath?: string;
}

export class CodexDriver extends HarnessEntrantDriver {
  private readonly authPath: string;

  constructor(journal: EventJournal, options: CodexDriverOptions = {}) {
    super(journal, options);
    this.authPath = options.authPath ?? join(homedir(), '.codex', 'auth.json');
  }

  protected harnessName(): string {
    return 'codex';
  }

  protected assertHarness(entrant: EntrantRecord): void {
    if (entrant.harness !== 'codex') {
      throw new Error(`CodexDriver cannot run harness ${entrant.harness}`);
    }
  }

  protected async createContainer(run: RunRecord, entrant: EntrantRecord): Promise<EntrantContainer> {
    const authJson = await readFile(this.authPath, 'utf8');
    registerCredentialSecrets(run.id, stringLeaves(JSON.parse(authJson) as unknown));
    const wallet = getWallet(run.id, entrant.id);
    // Only pin a model when the preset asks for a specific one. A ChatGPT-account
    // login rejects API-only models (gpt-5, gpt-5-codex) with a 400, so 'default'
    // (or empty) leaves codex on the account's own default model.
    const pinsModel = entrant.model !== '' && entrant.model.toLowerCase() !== 'default';
    const config = [
      pinsModel ? `model = ${tomlString(entrant.model)}\n` : '',
      entrant.effort === null
        ? ''
        : `model_reasoning_effort = ${tomlString(entrant.effort)}\n`,
    ].join('');
    return this.containerFactory({
      runId: run.id,
      entrantId: entrant.id,
      credentialFiles: [
        { path: '/creds/codex/auth.json', content: authJson, mode: 0o600 },
        { path: '/creds/codex/config.toml', content: config, mode: 0o644 },
      ],
      env: {
        CODEX_HOME: '/creds/codex',
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
    return ['codex', '--version'];
  }

  protected startArgv(_entrant: EntrantRecord, prompt: string): string[] {
    return [
      'codex',
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '-C',
      '/work',
      prompt,
    ];
  }

  protected resumeArgv(_entrant: EntrantRecord, sessionId: string, text: string): string[] {
    // -C is a global option: it must precede the `resume` subcommand or the CLI
    // rejects it with "unexpected argument '-C'" and the steer never runs.
    return [
      'codex',
      'exec',
      '-C',
      '/work',
      'resume',
      sessionId,
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      text,
    ];
  }

  protected createParser(entrant: EntrantRecord): CodexEventParser {
    return new CodexEventParser(entrant.id, this.logger);
  }

  protected validateResumeSession(): boolean {
    return true;
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return isCredentialSecretLeaf(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(stringLeaves);
}

function isCredentialSecretLeaf(value: string): boolean {
  // Auth JSON includes account labels and issuer URLs that are not secrets.
  if (value.length < 16) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
  if (value.startsWith('http://') || value.startsWith('https://')) return false;
  return true;
}
