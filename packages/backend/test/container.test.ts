import { PassThrough, type Readable, type Writable } from 'node:stream';
import { resolve } from 'node:path';

import Docker from 'dockerode';
import { describe, expect, it, vi } from 'vitest';

import {
  DockerEntrantContainer,
  type ContainerOptions,
} from '../src/runtime/container.js';

interface FakeWaitResult {
  StatusCode: number;
}

interface FakeDialOptions {
  path: string;
  method: string;
  hijack?: boolean;
  openStdin?: boolean;
  headers?: Record<string, string>;
  file?: Buffer;
  options?: { _query?: Record<string, unknown> };
}

class FakeDocker {
  readonly attachment = new PassThrough();
  readonly runnerOutput = new PassThrough();
  readonly runnerError = new PassThrough();
  readonly network = { remove: vi.fn(async () => undefined) };
  readonly container;
  readonly createNetwork = vi.fn(async (_options: unknown) => this.network);
  readonly listContainers = vi.fn(async () => []);
  readonly listNetworks = vi.fn(async () => []);
  readonly commands: Array<Record<string, unknown>> = [];
  readonly dial = vi.fn((
    _options: FakeDialOptions,
    callback: (error: unknown, attachment: PassThrough) => void,
  ) => {
    callback(null, this.attachment);
  });

  private resolveWait!: (result: FakeWaitResult) => void;
  private inputBuffer = '';
  private readonly waitResult = new Promise<FakeWaitResult>((resolveWait) => {
    this.resolveWait = resolveWait;
  });

  constructor(
    private readonly onStart: (docker: FakeDocker) => void = (docker) => docker.send({ ev: 'ready' }),
    private readonly onCommand: (docker: FakeDocker, command: Record<string, unknown>) => void = (docker, command) => {
      if (command.cmd === 'file') docker.send({ ev: 'file-ok', id: command.id });
    },
  ) {
    this.attachment.on('data', (chunk: Buffer) => this.receiveCommandChunk(chunk));
    this.container = {
      id: 'fake-container-id',
      start: vi.fn(async () => this.onStart(this)),
      wait: vi.fn(async () => this.waitResult),
      stop: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      modem: {
        dial: this.dial,
        demuxStream: vi.fn((_attachment: Readable, output: Writable, error: Writable) => {
          this.runnerOutput.pipe(output);
          this.runnerError.pipe(error);
        }),
      },
    };
  }

  readonly createContainer = vi.fn(async (_options: unknown) => this.container);

  private receiveCommandChunk(chunk: Buffer): void {
    this.inputBuffer += chunk.toString('utf8');
    let newline = this.inputBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.inputBuffer.slice(0, newline);
      this.inputBuffer = this.inputBuffer.slice(newline + 1);
      const command = JSON.parse(line) as Record<string, unknown>;
      this.commands.push(command);
      this.onCommand(this, command);
      newline = this.inputBuffer.indexOf('\n');
    }
  }

  dialedAttach(): FakeDialOptions {
    const options = this.dial.mock.calls[0]?.[0];
    if (options === undefined) throw new Error('Expected the attach endpoint to be dialed');
    return options;
  }

  send(message: object): void {
    this.runnerOutput.write(`${JSON.stringify(message)}\n`);
  }

  die(code: number): void {
    this.resolveWait({ StatusCode: code });
    this.runnerOutput.end();
    this.runnerError.end();
    this.attachment.destroy();
  }

  failAttachment(error: Error): void {
    this.attachment.destroy(error);
  }
}

async function createContainer(
  docker: FakeDocker,
  options: Partial<ContainerOptions> = {},
): Promise<DockerEntrantContainer> {
  return DockerEntrantContainer.create({
    runId: 'runtime-unit',
    entrantId: 'entrant-1',
    readyTimeoutMs: 100,
    ...options,
  }, docker as unknown as Docker);
}

function createdBinds(docker: FakeDocker): string[] {
  const options = docker.createContainer.mock.calls[0]?.[0] as {
    HostConfig?: { Binds?: string[] };
  } | undefined;
  return options?.HostConfig?.Binds ?? [];
}

function createdNetworkName(docker: FakeDocker): string {
  const options = docker.createNetwork.mock.calls[0]?.[0] as { Name?: string } | undefined;
  if (options?.Name === undefined) throw new Error('Expected a network to be created');
  return options.Name;
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Promise stayed pending after container death')), 100);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('DockerEntrantContainer attach', () => {
  it('attaches with an empty request body so nothing can leak into runner stdin', async () => {
    const docker = new FakeDocker();

    await createContainer(docker);

    const dialed = docker.dialedAttach();
    expect(dialed.method).toBe('POST');
    expect(dialed.path).toBe('/containers/fake-container-id/attach?');
    expect(dialed.hijack).toBe(true);
    // openStdin keeps the request unfinished, so the hijacked socket stays writable.
    expect(dialed.openStdin).toBe(true);
    // The body is empty and every attach parameter travels in the query string:
    // docker-modem would otherwise POST the options object, and the daemon can
    // hand those bytes to the container as its first stdin read.
    expect(dialed.file).toEqual(Buffer.alloc(0));
    expect(dialed.headers).toEqual({ 'Content-Type': 'text/plain' });
    expect(dialed.options).toEqual({
      _query: { stream: true, stdin: true, stdout: true, stderr: true },
    });
  });

  it('propagates an attach failure and cleans up the container and network', async () => {
    const docker = new FakeDocker();
    docker.dial.mockImplementationOnce((_options, callback) => {
      callback(new Error('no such container'), docker.attachment);
    });

    await expect(createContainer(docker)).rejects.toThrow('no such container');

    expect(docker.container.remove).toHaveBeenCalledWith({ force: true });
    expect(docker.network.remove).toHaveBeenCalledOnce();
  });
});

describe('DockerEntrantContainer lifecycle', () => {
  it('keeps the network uniqueness suffix with a max-length entrant id', async () => {
    const docker = new FakeDocker();

    await createContainer(docker, {
      runId: '12345678-1234-1234-1234-123456789abc',
      entrantId: 'abcdefghijklmnopqrst',
    });

    const networkName = createdNetworkName(docker);
    expect(networkName.length).toBeLessThanOrEqual(63);
    expect(networkName).toMatch(/-[0-9a-f]{8}$/);
  });

  it('rejects readiness when the container dies before the ready event', async () => {
    const docker = new FakeDocker((startedDocker) => startedDocker.die(137));

    await expect(createContainer(docker)).rejects.toThrow('Container exited with code 137');
  });

  it('rejects an in-flight execution and its line iterator when the container dies', async () => {
    const docker = new FakeDocker();
    const container = await createContainer(docker);
    const execution = await container.exec(['node', '-e', 'setTimeout(() => {}, 30_000)']);
    const nextLine = execution[Symbol.asyncIterator]().next();

    docker.die(137);

    await expect(within(execution.exit)).rejects.toThrow('Container exited with code 137');
    await expect(within(nextLine)).rejects.toThrow('Container exited with code 137');
  });

  it('rejects an in-flight execution when the attachment errors before container wait settles', async () => {
    const docker = new FakeDocker();
    const container = await createContainer(docker);
    const execution = await container.exec(['node', '-e', 'setTimeout(() => {}, 30_000)']);

    docker.failAttachment(new Error('socket reset'));

    await expect(within(execution.exit)).rejects.toThrow(
      'Container attachment stream failed: socket reset',
    );
    await expect(within(execution[Symbol.asyncIterator]().next())).rejects.toThrow(
      'Container attachment stream failed: socket reset',
    );
  });

  it('keeps a clean JSON exit clean when the container closes afterward', async () => {
    const docker = new FakeDocker();
    const container = await createContainer(docker);
    const execution = await container.exec(['node', '-e', 'process.exit(0)']);

    docker.send({ ev: 'exit', id: execution.id, code: 0 });
    expect(await within(execution.exit)).toBe(0);
    await expect(within(execution[Symbol.asyncIterator]().next())).resolves.toEqual({
      done: true,
      value: undefined,
    });

    docker.die(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await execution.exit).toBe(0);
  });
});

describe('DockerEntrantContainer mounts', () => {
  it('mounts the challenge pack at /ctf as read-only with an absolute source', async () => {
    const docker = new FakeDocker();
    const challengePackDir = './test-challenge-pack';

    await createContainer(docker, { challengePackDir });

    expect(createdBinds(docker)).toContain(`${resolve(challengePackDir)}:/ctf:ro`);
  });

  it('uses the configured challenge pack target', async () => {
    const docker = new FakeDocker();
    const challengePackDir = './test-challenge-pack';

    await createContainer(docker, {
      challengePackDir,
      challengePackTarget: '/arena/challenges',
    });

    expect(createdBinds(docker)).toContain(
      `${resolve(challengePackDir)}:/arena/challenges:ro`,
    );
  });

  it('adds no read-only bind without a challenge pack', async () => {
    const docker = new FakeDocker();

    await createContainer(docker);

    expect(createdBinds(docker).some((bind) => bind.endsWith(':ro'))).toBe(false);
  });

  it('injects credentials and only binds the challenge pack', async () => {
    const docker = new FakeDocker();
    const challengePackDir = './test-challenge-pack';

    await createContainer(docker, {
      credentialFiles: [
        { path: '/creds/test/auth.json', content: '{"token":"secret"}', mode: 0o600 },
        { path: '/creds/test/cache' },
      ],
      challengePackDir,
    });

    expect(createdBinds(docker)).toEqual([`${resolve(challengePackDir)}:/ctf:ro`]);
    expect(docker.commands).toEqual([
      {
        cmd: 'file',
        id: expect.any(String),
        path: '/creds/test/auth.json',
        data: Buffer.from('{"token":"secret"}', 'utf8').toString('base64'),
        mode: 0o600,
      },
      {
        cmd: 'file',
        id: expect.any(String),
        path: '/creds/test/cache',
      },
    ]);
  });

  it('tears down creation when credential injection fails', async () => {
    const docker = new FakeDocker(
      (startedDocker) => startedDocker.send({ ev: 'ready' }),
      (startedDocker, command) => {
        if (command.cmd === 'file') {
          startedDocker.send({
            ev: 'error',
            id: command.id,
            msg: `File ${String(command.id)} failed: EACCES`,
          });
        }
      },
    );

    await expect(createContainer(docker, {
      credentialFiles: [{ path: '/creds/test/auth.json', content: '{}' }],
    })).rejects.toThrow('failed: EACCES');

    expect(docker.container.remove).toHaveBeenCalledWith({ force: true });
    expect(docker.network.remove).toHaveBeenCalledOnce();
  });

  it('ignores a runner file error for a different transfer id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const docker = new FakeDocker(
      (startedDocker) => startedDocker.send({ ev: 'ready' }),
      (startedDocker, command) => {
        if (command.cmd === 'file') {
          startedDocker.send({
            ev: 'error',
            id: 'other-file',
            msg: 'File other-file failed: EACCES',
          });
          startedDocker.send({ ev: 'file-ok', id: command.id });
        }
      },
    );

    try {
      await expect(createContainer(docker, {
        credentialFiles: [{ path: '/creds/test/auth.json', content: '{}' }],
      })).resolves.toBeInstanceOf(DockerEntrantContainer);

      expect(warn).toHaveBeenCalledWith(
        '[arena runner] error for unknown transfer other-file: File other-file failed: EACCES',
      );
      expect(docker.container.remove).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('attributes a runner error without the transfer id to the pending file', async () => {
    // An image built before the file command replies without echoing the id.
    const docker = new FakeDocker(
      (startedDocker) => startedDocker.send({ ev: 'ready' }),
      (startedDocker, command) => {
        if (command.cmd === 'file') {
          startedDocker.send({ ev: 'error', msg: 'Unknown command: file' });
        }
      },
    );

    await expect(createContainer(docker, {
      credentialFiles: [{ path: '/creds/test/auth.json', content: '{}' }],
    })).rejects.toThrow('Unknown command: file');

    expect(docker.container.remove).toHaveBeenCalledWith({ force: true });
  });

  it('tears down creation when credential injection is not acknowledged', async () => {
    vi.useFakeTimers();
    try {
      const docker = new FakeDocker(
        (startedDocker) => startedDocker.send({ ev: 'ready' }),
        () => undefined,
      );
      const creation = createContainer(docker, {
        credentialFiles: [{ path: '/creds/test/auth.json', content: '{}' }],
      });
      const rejection = expect(creation).rejects.toThrow(/Runner file timeout/);

      await vi.advanceTimersByTimeAsync(10_000);

      await rejection;
      expect(docker.container.remove).toHaveBeenCalledWith({ force: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
