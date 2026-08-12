import { describe, expect, it, vi } from 'vitest';

import { readSessionJsonl } from '../src/adapters/session-usage.js';
import type { EntrantContainer, RuntimeExecution, RuntimeLine } from '../src/runtime/container.js';

class WedgedExecution implements RuntimeExecution {
  readonly id = 'wedged';
  readonly exit = new Promise<number | null>(() => undefined);
  killCalls = 0;

  async kill(): Promise<void> {
    this.killCalls += 1;
    return new Promise(() => undefined);
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeLine> {
    return { next: async () => new Promise(() => undefined) };
  }
}

describe('session transcript reads', () => {
  it('rejects at the deadline even when the iterator and kill never settle', async () => {
    vi.useFakeTimers();
    const execution = new WedgedExecution();
    const container: EntrantContainer = {
      exec: async () => execution,
      teardown: async () => undefined,
    };

    const read = readSessionJsonl(container, '/creds/codex', { timeoutMs: 25 });
    const rejection = expect(read).rejects.toThrow('session transcript read timed out');
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(execution.killCalls).toBe(1);
    vi.useRealTimers();
  });

  it('rejects the size limit without waiting for a wedged kill', async () => {
    const execution = new WedgedExecution();
    let delivered = false;
    execution[Symbol.asyncIterator] = () => ({
      next: async () => delivered
        ? new Promise(() => undefined)
        : (delivered = true, { done: false, value: { stream: 'out', line: 'too large' } }),
    });
    const container: EntrantContainer = {
      exec: async () => execution,
      teardown: async () => undefined,
    };

    await expect(readSessionJsonl(container, '/creds/codex', { maxBytes: 1 }))
      .rejects.toThrow('session transcripts exceed the 64 MiB recovery limit');
    expect(execution.killCalls).toBe(1);
  });
});
