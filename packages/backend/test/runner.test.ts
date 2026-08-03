import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface, type Interface } from 'node:readline';

import { afterEach, describe, expect, it } from 'vitest';

const runnerPath = fileURLToPath(new URL('../../../docker/runner.mjs', import.meta.url));
const children = new Set<ChildProcessWithoutNullStreams>();
const temporaryPaths: string[] = [];

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function startRunner(): {
  child: ChildProcessWithoutNullStreams;
  lines: AsyncIterator<string>;
  reader: Interface;
} {
  const child = spawn(process.execPath, [runnerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  return { child, lines: reader[Symbol.asyncIterator](), reader };
}

async function nextMessage(lines: AsyncIterator<string>): Promise<Record<string, unknown>> {
  const result = await Promise.race([
    lines.next(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for runner output')), 2_000);
    }),
  ]);
  if (result.done) throw new Error('Runner stdout closed');
  return JSON.parse(result.value) as Record<string, unknown>;
}

async function stopRunner(
  child: ChildProcessWithoutNullStreams,
  reader: Interface,
): Promise<void> {
  child.stdin.write(`${JSON.stringify({ cmd: 'shutdown' })}\n`);
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  reader.close();
  children.delete(child);
}

describe('in-container runner protocol', () => {
  it('writes a base64 file with the requested mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arena-runner-test-'));
    temporaryPaths.push(directory);
    const path = join(directory, 'nested', 'auth.json');
    const { child, lines, reader } = startRunner();
    await nextMessage(lines);

    child.stdin.write(`${JSON.stringify({
      cmd: 'file',
      id: 'file-1',
      path,
      data: Buffer.from('{"token":"secret"}\n', 'utf8').toString('base64'),
      mode: 0o640,
    })}\n`);

    expect(await nextMessage(lines)).toEqual({ ev: 'file-ok', id: 'file-1' });
    expect(await readFile(path, 'utf8')).toBe('{"token":"secret"}\n');
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    await stopRunner(child, reader);
  });

  it('creates a directory when data is absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arena-runner-test-'));
    temporaryPaths.push(directory);
    const path = join(directory, 'nested', 'credential-home');
    const { child, lines, reader } = startRunner();
    await nextMessage(lines);

    child.stdin.write(`${JSON.stringify({ cmd: 'file', id: 'dir-1', path })}\n`);

    expect(await nextMessage(lines)).toEqual({ ev: 'file-ok', id: 'dir-1' });
    expect((await stat(path)).isDirectory()).toBe(true);
    await stopRunner(child, reader);
  });

  it('includes the file command id in an error reply', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arena-runner-test-'));
    temporaryPaths.push(directory);
    const path = join(directory, 'collision');
    await writeFile(path, 'already a file');
    const { child, lines, reader } = startRunner();
    await nextMessage(lines);

    child.stdin.write(`${JSON.stringify({ cmd: 'file', id: 'dir-error', path })}\n`);

    expect(await nextMessage(lines)).toEqual({
      ev: 'error',
      id: 'dir-error',
      msg: expect.stringContaining('dir-error'),
    });
    await stopRunner(child, reader);
  });

  it('streams command lines and an exit event', async () => {
    const { child, lines, reader } = startRunner();
    expect(await nextMessage(lines)).toEqual({ ev: 'ready' });

    child.stdin.write(`${JSON.stringify({
      cmd: 'exec',
      id: 'echo-1',
      argv: [process.execPath, '-e', "console.log('hello arena')"],
    })}\n`);

    expect(await nextMessage(lines)).toEqual({
      ev: 'line',
      id: 'echo-1',
      stream: 'out',
      line: 'hello arena',
    });
    expect(await nextMessage(lines)).toEqual({ ev: 'exit', id: 'echo-1', code: 0 });
    await stopRunner(child, reader);
  });

  it('rejects an overlapping exec and kills the active process group', async () => {
    const { child, lines, reader } = startRunner();
    await nextMessage(lines);

    child.stdin.write(`${JSON.stringify({
      cmd: 'exec',
      id: 'slow',
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 30_000)'],
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      cmd: 'exec',
      id: 'overlap',
      argv: [process.execPath, '-e', 'process.exit(0)'],
    })}\n`);

    expect(await nextMessage(lines)).toEqual({ ev: 'error', msg: 'Exec slow is still running' });
    child.stdin.write(`${JSON.stringify({ cmd: 'kill', id: 'slow' })}\n`);
    expect(await nextMessage(lines)).toMatchObject({ ev: 'exit', id: 'slow' });
    await stopRunner(child, reader);
  });
});
