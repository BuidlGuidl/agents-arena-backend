import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

let active = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function forwardLines(id, stream, input) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => send({ ev: 'line', id, stream, line }));
  return lines;
}

function killProcessGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') child.kill(signal);
  }
}

function killActive(id) {
  if (active === null || active.id !== id) {
    send({ ev: 'error', msg: `No active exec with id ${id}` });
    return;
  }

  const child = active.child;
  killProcessGroup(child, 'SIGTERM');
  // Track the force-kill timer so the child's close handler can clear it. Left
  // pending, it could later SIGKILL a new child that reused this process-group id.
  active.force = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 2_000);
  active.force.unref();
}

async function createFile(message) {
  try {
    if (message.data === undefined) {
      await mkdir(message.path, { recursive: true });
    } else {
      await mkdir(dirname(message.path), { recursive: true });
      await writeFile(message.path, Buffer.from(message.data, 'base64'), {
        mode: message.mode ?? 0o600,
      });
    }
    send({ ev: 'file-ok', id: message.id });
  } catch (error) {
    send({ ev: 'error', msg: `File ${message.id} failed: ${error.message}` });
  }
}

function execute(message) {
  if (active !== null) {
    send({ ev: 'error', msg: `Exec ${active.id} is still running` });
    return;
  }
  if (!Array.isArray(message.argv) || message.argv.length === 0 ||
      message.argv.some((value) => typeof value !== 'string')) {
    send({ ev: 'error', msg: 'exec requires a non-empty string argv array' });
    return;
  }

  const [command, ...args] = message.argv;
  const child = spawn(command, args, {
    detached: true,
    env: { ...process.env, ...(message.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = forwardLines(message.id, 'out', child.stdout);
  const stderr = forwardLines(message.id, 'err', child.stderr);
  active = { id: message.id, child, force: undefined };

  child.once('error', (error) => {
    send({ ev: 'error', msg: `Exec ${message.id} failed: ${error.message}` });
  });
  child.once('close', (code) => {
    stdout.close();
    stderr.close();
    if (active?.id === message.id) {
      if (active.force !== undefined) clearTimeout(active.force);
      active = null;
    }
    send({ ev: 'exit', id: message.id, code });
  });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ ev: 'error', msg: 'Malformed command JSON' });
    return;
  }

  if (message.cmd === 'file') {
    void createFile(message);
  } else if (message.cmd === 'exec') {
    execute(message);
  } else if (message.cmd === 'kill') {
    killActive(message.id);
  } else if (message.cmd === 'shutdown') {
    if (active === null) {
      process.exit(0);
    }
    killProcessGroup(active.child, 'SIGTERM');
    active.child.once('close', () => process.exit(0));
  } else {
    send({ ev: 'error', msg: `Unknown command: ${String(message.cmd)}` });
  }
});

process.stdin.resume();
send({ ev: 'ready' });
