import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { issueAgentToken } from '../agent-auth.js';
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
    const container = await this.containerFactory({
      runId: run.id,
      entrantId: entrant.id,
      credentialFiles: [
        { path: '/creds/codex/auth.json', content: authJson, mode: 0o600 },
        { path: '/creds/codex/config.toml', content: config, mode: 0o644 },
      ],
      env: {
        CODEX_HOME: '/creds/codex',
        ETH_RPC_URL: this.rpcUrl,
        ARENA_API_URL: this.agentApiUrl,
        ARENA_AGENT_TOKEN: issueAgentToken(run.id, entrant.id),
        ...(wallet === null
          ? {}
          : {
            WALLET_ADDRESS: wallet.address,
            WALLET_PRIVATE_KEY: wallet.privateKey,
          }),
      },
    });
    // Codex rotates its refresh token on use, and the rotated auth.json exists
    // only inside the container. Without the sync-back the host copy is left
    // consumed, and the next run dies with "refresh_token_reused" until the
    // operator logs in again.
    return {
      exec: (argv, env) => container.exec(argv, env),
      teardown: async () => {
        await this.syncAuthBack(run.id, container, authJson);
        await container.teardown();
      },
    };
  }

  // Reads the container's auth.json right before teardown, while the runner is
  // idle between turns. The host file only follows the container's rotation
  // while the operator has not re-logged-in meanwhile: a host copy that no
  // longer matches what this run seeded belongs to a newer login and must win.
  private async syncAuthBack(runId: string, container: EntrantContainer, seededAuth: string): Promise<void> {
    try {
      const execution = await container.exec(['cat', '/creds/codex/auth.json']);
      const lines: string[] = [];
      for await (const output of execution) {
        if (output.stream === 'out') lines.push(output.line);
      }
      if (await execution.exit !== 0) return;
      const refreshed = lines.join('\n');
      if (refreshed.trim() === seededAuth.trim()) return;
      // Anything that does not parse is a broken read, not a rotation.
      const parsed = JSON.parse(refreshed) as unknown;
      // The rotation minted a fresh token; scrub it like the seeded one so a late
      // event that echoes it cannot reach the feed.
      registerCredentialSecrets(runId, stringLeaves(parsed));
      const hostAuth = await readFile(this.authPath, 'utf8').catch(() => undefined);
      if (hostAuth !== undefined && hostAuth.trim() !== seededAuth.trim()) return;
      await writeFile(this.authPath, refreshed);
      this.logger.info('[codex] synced the rotated auth.json back to the host');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[codex] auth sync-back failed: ${message}`);
    }
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
