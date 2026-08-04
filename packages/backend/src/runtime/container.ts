import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';

import Docker from 'dockerode';

export interface RuntimeLine {
  stream: 'out' | 'err';
  line: string;
}

export interface RuntimeExecution extends AsyncIterable<RuntimeLine> {
  readonly id: string;
  readonly exit: Promise<number | null>;
  kill(): Promise<void>;
}

export interface ContainerOptions {
  runId: string;
  entrantId: string;
  image?: string;
  env?: Record<string, string>;
  // A directory entry is bare {path}; mode only applies to file content, the
  // runner creates directories with its own default.
  credentialFiles?: Array<
    | { path: string; content?: never; mode?: never }
    | { path: string; content: string; mode?: number }
  >;
  challengePackDir?: string;
  challengePackTarget?: string;
  readyTimeoutMs?: number;
}

// The opening prompt names this path, so it has one definition.
export const CHALLENGE_PACK_MOUNT = '/ctf';

export interface EntrantContainer {
  exec(argv: string[], env?: Record<string, string>): Promise<RuntimeExecution>;
  teardown(): Promise<void>;
}

export type ContainerFactory = (options: ContainerOptions) => Promise<EntrantContainer>;

interface RunnerLineMessage {
  ev: 'line';
  id: string;
  stream: 'out' | 'err';
  line: string;
}

interface RunnerExitMessage {
  ev: 'exit';
  id: string;
  code: number | null;
}

interface RunnerReadyMessage {
  ev: 'ready';
}

interface RunnerFileOkMessage {
  ev: 'file-ok';
  id: string;
}

interface RunnerErrorMessage {
  ev: 'error';
  id?: string;
  msg: string;
}

type RunnerMessage = RunnerLineMessage | RunnerExitMessage | RunnerReadyMessage | RunnerFileOkMessage | RunnerErrorMessage;

interface PendingFile {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class AsyncLineQueue implements AsyncIterable<RuntimeLine> {
  private readonly values: RuntimeLine[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<RuntimeLine>) => void;
    reject: (error: Error) => void;
  }> = [];
  private ended = false;
  private failure: Error | undefined;

  push(value: RuntimeLine): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeLine> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.failure !== undefined) throw this.failure;
        if (this.ended) return { done: true, value: undefined };
        return new Promise<IteratorResult<RuntimeLine>>((resolveWaiter, rejectWaiter) => {
          this.waiters.push({ resolve: resolveWaiter, reject: rejectWaiter });
        });
      },
    };
  }
}

class DockerRuntimeExecution implements RuntimeExecution {
  readonly exit: Promise<number | null>;
  readonly lines = new AsyncLineQueue();
  private resolveExit!: (code: number | null) => void;
  private rejectExit!: (error: Error) => void;

  constructor(
    readonly id: string,
    private readonly sendKill: (id: string) => Promise<void>,
  ) {
    this.exit = new Promise<number | null>((resolveExit, rejectExit) => {
      this.resolveExit = resolveExit;
      this.rejectExit = rejectExit;
    });
    // Guard consumer: on the error path a caller catches the iterator rejection and
    // never awaits exit, so its rejection would surface as an unhandled rejection and
    // crash the process. This no-op marks it handled; real awaiters still see the throw.
    void this.exit.catch(() => undefined);
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeLine> {
    return this.lines[Symbol.asyncIterator]();
  }

  finish(code: number | null): void {
    this.lines.close();
    this.resolveExit(code);
  }

  fail(error: Error): void {
    this.lines.fail(error);
    this.rejectExit(error);
  }

  async kill(): Promise<void> {
    await this.sendKill(this.id);
  }
}

export class DockerEntrantContainer implements EntrantContainer {
  private readonly executions = new Map<string, DockerRuntimeExecution>();
  private readonly pendingFiles = new Map<string, PendingFile>();
  private readonly pendingWriteRejectors = new Set<(error: Error) => void>();
  private activeExecution: DockerRuntimeExecution | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private terminalError: Error | undefined;
  private observedExitCode: number | null | undefined;
  private streamFailure: Error | undefined;
  private terminationCheck: NodeJS.Immediate | undefined;
  private tornDown = false;

  private constructor(
    private readonly container: Docker.Container,
    private readonly network: Docker.Network,
    private readonly input: NodeJS.ReadWriteStream,
    runnerOutput: NodeJS.ReadableStream,
    runnerError: NodeJS.ReadableStream,
  ) {
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady;
      this.rejectReady = rejectReady;
    });
    // Guard consumer: once waitUntilReady has settled, a later runner ev:error
    // still calls rejectReady. Without a handler that becomes an unhandled
    // rejection and crashes the process; real awaiters still see the throw.
    void this.ready.catch(() => undefined);

    const outputLines = createInterface({ input: runnerOutput, crlfDelay: Infinity });
    outputLines.on('line', (line) => this.receive(line));
    outputLines.once('close', () => {
      this.scheduleTermination(new Error('Container attachment stream closed before runner exit'));
    });
    runnerOutput.once('error', (error) => {
      this.scheduleTermination(new Error(`Container runner output failed: ${asError(error).message}`));
    });
    const errorLines = createInterface({ input: runnerError, crlfDelay: Infinity });
    errorLines.on('line', (line) => console.warn(`[arena runner stderr] ${line}`));
    runnerError.once('error', (error) => {
      this.scheduleTermination(new Error(`Container runner error output failed: ${asError(error).message}`));
    });
    input.once('end', () => {
      this.scheduleTermination(new Error('Container attachment stream ended before runner exit'));
    });
    input.once('close', () => {
      this.scheduleTermination(new Error('Container attachment stream closed before runner exit'));
    });
    input.once('error', (error) => {
      this.scheduleTermination(new Error(`Container attachment stream failed: ${asError(error).message}`));
    });
  }

  static async create(options: ContainerOptions, docker = new Docker()): Promise<DockerEntrantContainer> {
    await removeStaleResources(docker, options.runId, options.entrantId);

    const suffix = randomUUID().slice(0, 8);
    // Slice before appending the suffix so a max-length entrant id cannot remove the collision guard.
    const networkName = `${safeDockerName(`arena-${options.runId}-${options.entrantId}`).slice(0, 54)}-${suffix}`;
    const network = await docker.createNetwork({
      Name: networkName,
      Driver: 'bridge',
      Labels: {
        'arena.runId': options.runId,
        'arena.entrantId': options.entrantId,
      },
    });

    let container: Docker.Container | undefined;
    try {
      const binds = [
        // hardening: the challenge pack is read-only so an entrant cannot edit the
        // briefing or the sources its rival reads from the same assembled pack.
        ...(options.challengePackDir === undefined
          ? []
          : [`${resolve(options.challengePackDir)}:${options.challengePackTarget ?? CHALLENGE_PACK_MOUNT}:ro`]),
      ];

      container = await docker.createContainer({
        Image: options.image ?? 'arena-entrant:dev',
        name: safeDockerName(`arena-${options.runId}-${options.entrantId}`),
        Env: Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
        Labels: {
          'arena.runId': options.runId,
          'arena.entrantId': options.entrantId,
        },
        OpenStdin: true,
        StdinOnce: false,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        WorkingDir: '/work',
        HostConfig: {
          AutoRemove: false,
          Binds: binds,
          NetworkMode: networkName,
          Init: true,
          ExtraHosts: ['host.docker.internal:host-gateway'],
          // hardening: no capabilities, no privilege escalation, bounded PIDs, memory, and CPU.
          // hardening: each entrant gets a private network; credentials stay in its writable layer.
          // hardening: never mount the Docker socket and never run a privileged container.
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          PidsLimit: 512,
          Memory: 2 * 1024 * 1024 * 1024,
          NanoCpus: 2_000_000_000,
          Privileged: false,
        },
      });

      const attachment = await attachWithoutRequestBody(container);
      const runnerOutput = new PassThrough();
      const runnerError = new PassThrough();
      const runtime = new DockerEntrantContainer(
        container,
        network,
        attachment,
        runnerOutput,
        runnerError,
      );
      container.modem.demuxStream(attachment, runnerOutput, runnerError);
      const start = container.start();
      runtime.observeContainerDeath();
      await start;
      await runtime.waitUntilReady(options.readyTimeoutMs ?? 15_000);
      for (const file of options.credentialFiles ?? []) {
        await runtime.createFile(file);
      }
      return runtime;
    } catch (error) {
      const failedContainer = container;
      if (failedContainer !== undefined) {
        await ignoreDockerError(() => failedContainer.remove({ force: true }));
      }
      await ignoreDockerError(() => network.remove());
      throw error;
    }
  }

  async exec(argv: string[], env?: Record<string, string>): Promise<RuntimeExecution> {
    if (this.tornDown) throw new Error('Container is already torn down');
    if (this.terminalError !== undefined) throw this.terminalError;
    if (this.activeExecution !== undefined) {
      throw new Error(`Exec ${this.activeExecution.id} is still running`);
    }
    if (argv.length === 0) throw new Error('argv must not be empty');

    const id = randomUUID();
    const execution = new DockerRuntimeExecution(id, async (executionId) => {
      await this.write({ cmd: 'kill', id: executionId });
    });
    this.executions.set(id, execution);
    this.activeExecution = execution;
    try {
      await this.write({ cmd: 'exec', id, argv, ...(env === undefined ? {} : { env }) });
    } catch (error) {
      this.executions.delete(id);
      this.activeExecution = undefined;
      execution.fail(asError(error));
      throw error;
    }
    return execution;
  }

  async teardown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;

    if (this.activeExecution !== undefined) {
      await ignoreDockerError(() => this.activeExecution?.kill() ?? Promise.resolve());
    }
    await ignoreDockerError(() => this.write({ cmd: 'shutdown' }));
    await ignoreDockerError(() => this.container.stop({ t: 3 }));
    this.terminateExpectedly();
    await ignoreDockerError(() => this.container.remove({ force: true }));
    await ignoreDockerError(() => this.network.remove());
  }

  private receive(line: string): void {
    let message: RunnerMessage;
    try {
      message = JSON.parse(line) as RunnerMessage;
    } catch {
      console.warn(`[arena runner] malformed JSON: ${line}`);
      return;
    }

    if (message.ev === 'ready') {
      this.resolveReady();
      return;
    }
    if (message.ev === 'file-ok') {
      const pending = this.pendingFiles.get(message.id);
      if (pending === undefined) {
        console.warn(`[arena runner] file event for unknown transfer ${message.id}`);
        return;
      }
      clearTimeout(pending.timer);
      this.pendingFiles.delete(message.id);
      pending.resolve();
      return;
    }
    if (message.ev === 'error') {
      const error = new Error(message.msg);
      if (message.id !== undefined) {
        const pending = this.pendingFiles.get(message.id);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          this.pendingFiles.delete(message.id);
          pending.reject(error);
          return;
        }
        if (this.pendingFiles.size > 0) {
          console.warn(
            `[arena runner] error for unknown transfer ${message.id}: ${message.msg}`,
          );
          return;
        }
      }
      // Injection is serialized inside create(), before any exec can start, so a
      // runner error while a transfer is pending can only belong to that transfer —
      // even when the runner can't echo the id (old image, malformed command).
      if (this.pendingFiles.size > 0) {
        for (const [id, pending] of this.pendingFiles) {
          clearTimeout(pending.timer);
          this.pendingFiles.delete(id);
          pending.reject(error);
        }
        return;
      }
      if (this.activeExecution !== undefined) {
        this.activeExecution.fail(error);
        this.executions.delete(this.activeExecution.id);
        this.activeExecution = undefined;
      } else {
        this.rejectReady(error);
        console.warn(`[arena runner] ${message.msg}`);
      }
      return;
    }

    const execution = this.executions.get(message.id);
    if (execution === undefined) {
      console.warn(`[arena runner] event for unknown exec ${message.id}`);
      return;
    }
    if (message.ev === 'line') {
      execution.lines.push({ stream: message.stream, line: message.line });
      return;
    }

    execution.finish(message.code);
    this.executions.delete(message.id);
    if (this.activeExecution?.id === message.id) this.activeExecution = undefined;
  }

  private observeContainerDeath(): void {
    // Registered before container.start(). The default wait condition
    // (not-running) resolves immediately for a created container, which read
    // as a phantom exit-0 death — next-exit waits for a real exit instead.
    void this.container.wait({ condition: 'next-exit' }).then(
      (result: unknown) => {
        this.observedExitCode = containerExitCode(result);
        this.scheduleTermination(containerExitError(this.observedExitCode));
      },
      (error: unknown) => {
        this.scheduleTermination(new Error(`Container wait failed: ${asError(error).message}`));
      },
    );
  }

  private scheduleTermination(error: Error): void {
    if (this.terminalError !== undefined) return;
    this.streamFailure ??= error;
    if (this.terminationCheck !== undefined) return;

    // Let readline drain any JSON exit event already buffered in the attachment.
    // Docker's wait response and attachment closure can arrive in either order.
    this.terminationCheck = setImmediate(() => {
      this.terminationCheck = undefined;
      if (this.terminalError !== undefined) return;
      if (this.tornDown) {
        this.terminateExpectedly();
        return;
      }
      this.terminateUnexpectedly(
        this.observedExitCode === undefined
          ? this.streamFailure ?? error
          : containerExitError(this.observedExitCode),
      );
    });
  }

  private terminateUnexpectedly(error: Error): void {
    if (this.terminalError !== undefined) return;
    this.terminalError = error;
    this.rejectReady(error);
    for (const execution of this.executions.values()) execution.fail(error);
    this.executions.clear();
    this.activeExecution = undefined;
    for (const [id, pending] of this.pendingFiles) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingFiles.delete(id);
    }
    this.rejectPendingWrites(error);
  }

  private terminateExpectedly(): void {
    if (this.terminalError !== undefined) return;
    const error = new Error('Container stopped during teardown');
    this.terminalError = error;
    this.resolveReady();
    for (const execution of this.executions.values()) execution.finish(null);
    this.executions.clear();
    this.activeExecution = undefined;
    for (const [id, pending] of this.pendingFiles) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingFiles.delete(id);
    }
    this.rejectPendingWrites(error);
  }

  private rejectPendingWrites(error: Error): void {
    for (const rejectWrite of [...this.pendingWriteRejectors]) rejectWrite(error);
  }

  private async waitUntilReady(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Runner ready timeout')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async createFile(file: { path: string; content?: string; mode?: number }): Promise<void> {
    const id = randomUUID();
    const acknowledgment = new Promise<void>((resolveFile, rejectFile) => {
      const timer = setTimeout(() => {
        this.pendingFiles.delete(id);
        rejectFile(new Error(`Runner file timeout for ${id}: ${file.path}`));
      }, 10_000);
      this.pendingFiles.set(id, { resolve: resolveFile, reject: rejectFile, timer });
    });
    void acknowledgment.catch(() => undefined);
    try {
      // Race the write against the ack timer: a stalled attach stream otherwise
      // blocks here forever, with the timeout rejection going unobserved.
      await Promise.race([
        this.write({
          cmd: 'file',
          id,
          path: file.path,
          ...(file.content === undefined
            ? {}
            : { data: Buffer.from(file.content, 'utf8').toString('base64') }),
          ...(file.mode === undefined ? {} : { mode: file.mode }),
        }),
        acknowledgment,
      ]);
      await acknowledgment;
    } catch (error) {
      const pending = this.pendingFiles.get(id);
      if (pending !== undefined) clearTimeout(pending.timer);
      this.pendingFiles.delete(id);
      throw error;
    }
  }

  private write(message: object): Promise<void> {
    // Serialize writes: two commands writing concurrently can interleave their
    // bytes on the runner's stdin, which the runner then rejects as
    // "Malformed command JSON". Chaining keeps each command a whole line.
    const line = `${JSON.stringify(message)}\n`;
    const next = this.writeQueue.then(
      () => new Promise<void>((resolveWrite, rejectWrite) => {
        if (this.terminalError !== undefined) {
          rejectWrite(this.terminalError);
          return;
        }

        let settled = false;
        const finishWrite = (error?: Error | null): void => {
          if (settled) return;
          settled = true;
          this.pendingWriteRejectors.delete(rejectOnTermination);
          if (error === undefined || error === null) resolveWrite();
          else rejectWrite(error);
        };
        const rejectOnTermination = (error: Error): void => finishWrite(error);
        this.pendingWriteRejectors.add(rejectOnTermination);
        try {
          this.input.write(line, finishWrite);
        } catch (error) {
          finishWrite(asError(error));
        }
      }),
    );
    // Keep the queue alive if one write rejects, so a single failure can't wedge it.
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

export const createDockerContainer: ContainerFactory = (options) => DockerEntrantContainer.create(options);

// dockerode's container.attach() sends its own options object as the POST body.
// The daemon hijacks the connection for attach without always consuming that
// body first, so those bytes can resurface as the first thing the container
// reads on stdin, glued to our first command — the runner then rejects one
// malformed line. Dial the endpoint ourselves with no body; every attach
// parameter belongs in the query string anyway.
//
// The empty Buffer is the body: docker-modem only writes and flushes the
// request headers when it has data, so omitting the body entirely leaves the
// headers buffered and the attach never completes. An empty Buffer gives us
// Content-Length: 0 and a flush, and openStdin keeps the request unfinished so
// the hijacked socket stays writable.
async function attachWithoutRequestBody(container: Docker.Container): Promise<NodeJS.ReadWriteStream> {
  return new Promise<NodeJS.ReadWriteStream>((resolveAttachment, rejectAttachment) => {
    container.modem.dial(
      {
        path: `/containers/${container.id}/attach?`,
        method: 'POST',
        isStream: true,
        hijack: true,
        openStdin: true,
        statusCodes: { 200: true, 404: 'no such container', 500: 'server error' },
        options: { _query: { stream: true, stdin: true, stdout: true, stderr: true }, _body: {} },
        file: Buffer.alloc(0),
      },
      (error: unknown, attachment: NodeJS.ReadWriteStream) => {
        if (error !== null && error !== undefined) rejectAttachment(asError(error));
        else resolveAttachment(attachment);
      },
    );
  });
}

async function removeStaleResources(docker: Docker, runId: string, entrantId: string): Promise<void> {
  const labels = [`arena.runId=${runId}`, `arena.entrantId=${entrantId}`];
  const staleContainers = await docker.listContainers({ all: true, filters: { label: labels } });
  await Promise.all(staleContainers.map(async ({ Id }) => {
    await ignoreDockerError(() => docker.getContainer(Id).remove({ force: true }));
  }));

  const staleNetworks = await docker.listNetworks({ filters: { label: labels } });
  await Promise.all(staleNetworks.map(async ({ Id }) => {
    if (Id !== undefined) await ignoreDockerError(() => docker.getNetwork(Id).remove());
  }));
}

async function ignoreDockerError(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // Cleanup is best effort. The daemon can report an object as already gone.
  }
}

function safeDockerName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 63);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function containerExitCode(result: unknown): number | null {
  if (
    typeof result === 'object'
    && result !== null
    && 'StatusCode' in result
    && typeof result.StatusCode === 'number'
  ) {
    return result.StatusCode;
  }
  return null;
}

function containerExitError(code: number | null): Error {
  return new Error(`Container exited with code ${code === null ? 'unknown' : String(code)}`);
}
