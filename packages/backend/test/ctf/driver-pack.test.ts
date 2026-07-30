import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HarnessEntrantDriver,
  type HarnessDriverOptions,
} from '../../src/adapters/harness-driver.js';
import type { HarnessLineParser, ParsedHarnessLine } from '../../src/adapters/parser-types.js';
import type { EntrantRecord, RunRecord } from '../../src/adapters/types.js';
import { EventJournal } from '../../src/journal.js';
import type {
  ContainerFactory,
  ContainerOptions,
  EntrantContainer,
  RuntimeExecution,
} from '../../src/runtime/container.js';

class TestHarnessDriver extends HarnessEntrantDriver {
  constructor(journal: EventJournal, options: HarnessDriverOptions) {
    super(journal, options);
  }

  protected harnessName(): string {
    return 'test';
  }

  protected assertHarness(_entrant: EntrantRecord): void {}

  protected createContainer(
    run: RunRecord,
    entrant: EntrantRecord,
  ): Promise<EntrantContainer> {
    return this.containerFactory({
      runId: run.id,
      entrantId: entrant.id,
    });
  }

  protected versionArgv(): string[] {
    return ['test', '--version'];
  }

  protected startArgv(_entrant: EntrantRecord, prompt: string): string[] {
    return ['test', prompt];
  }

  protected resumeArgv(
    _entrant: EntrantRecord,
    sessionId: string,
    text: string,
  ): string[] {
    return ['test', sessionId, text];
  }

  protected createParser(): HarnessLineParser {
    return { parse: (): ParsedHarnessLine => ({ events: [] }) };
  }
}

const run: RunRecord = {
  id: 'run-pack',
  state: 'created',
  preset: 'test',
  startedAt: null,
  deadlineAt: null,
  idempotencyKey: null,
};

const entrant: EntrantRecord = {
  runId: run.id,
  id: 'entrant-pack',
  harness: 'codex',
  model: 'test-model',
  address: null,
  status: 'idle',
  flags: 0,
};

function successfulExecution(id: string): RuntimeExecution {
  return {
    id,
    exit: Promise.resolve(0),
    async kill() {},
    async *[Symbol.asyncIterator]() {},
  };
}

const journals: EventJournal[] = [];

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
});

function setup(options: Pick<HarnessDriverOptions, 'resolveChallengePack'> = {}): {
  driver: TestHarnessDriver;
  containerFactory: ReturnType<typeof vi.fn<ContainerFactory>>;
} {
  const journal = new EventJournal(':memory:');
  journals.push(journal);
  const container: EntrantContainer = {
    exec: vi.fn(async () => successfulExecution('preflight')),
    teardown: vi.fn(async () => undefined),
  };
  const containerFactory = vi.fn<ContainerFactory>(
    async (_containerOptions: ContainerOptions) => container,
  );
  const driver = new TestHarnessDriver(journal, {
    containerFactory,
    ...options,
  });
  return { driver, containerFactory };
}

describe('HarnessEntrantDriver challenge pack', () => {
  it('passes the resolved pack path to the container factory', async () => {
    const packPath = '/tmp/fixed-challenge-pack';
    const resolveChallengePack = vi.fn((_runId: string) => packPath);
    const { driver, containerFactory } = setup({ resolveChallengePack });

    await driver.prepare(run, entrant);

    expect(resolveChallengePack).toHaveBeenCalledWith(run.id);
    expect(containerFactory).toHaveBeenCalledWith(expect.objectContaining({
      challengePackDir: packPath,
    }));
  });

  it('leaves challengePackDir undefined without a resolver', async () => {
    const { driver, containerFactory } = setup();

    await driver.prepare(run, entrant);

    const options = containerFactory.mock.calls[0]?.[0];
    expect(options?.challengePackDir).toBeUndefined();
  });
});
