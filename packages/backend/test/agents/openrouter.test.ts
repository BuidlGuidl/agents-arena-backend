import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenRouterModelSource, OpenRouterUnavailableError } from '../../src/agents/openrouter.js';

const row = { id: 'google/gemini', name: 'Google: Gemini: Pro', supported_parameters: ['reasoning', 'tools'], architecture: { output_modalities: ['text'] } };
const response = () => Response.json({ data: [row] });
afterEach(() => vi.useRealTimers());

describe('OpenRouter model source', () => {
  it('rejects a cold list with no usable models', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      data: [{ ...row, supported_parameters: [] }, { name: 'No id' }],
    }));
    const source = createOpenRouterModelSource({ fetch });
    await expect(source.list()).rejects.toBeInstanceOf(OpenRouterUnavailableError);
  });

  it('keeps the cached list and warns when a refresh has no usable models', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(Response.json({ data: [{ ...row, supported_parameters: [] }, { name: 'No id' }] }));
    const warn = vi.fn();
    const source = createOpenRouterModelSource({ fetch, ttlMs: 100, logger: { warn } });
    const first = await source.list();
    vi.advanceTimersByTime(100);

    expect(await source.list()).toBe(first);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('filters unstable and non-reasoning models and parses names defensively', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ data: [
      row,
      { ...row, id: '~google/latest' },
      { ...row, id: 'google/gemini:free' },
      { ...row, id: 'google/gemini:batch' },
      { ...row, id: 'google/no-tools', supported_parameters: ['reasoning'] },
      { ...row, id: 'google/image', architecture: { output_modalities: ['image', 'text'] } },
      { ...row, id: 'google/no-architecture', architecture: undefined },
      { ...row, id: 'google/no-modalities', architecture: {} },
      { ...row, id: 'google/bad-architecture', architecture: null },
      { ...row, id: 'google/plain', supported_parameters: [] },
      { ...row, id: 'google/missing', supported_parameters: undefined },
      { name: 'No id' }, null,
      { ...row, id: 'other/model', name: 'Whole name' },
      { ...row, id: 'other/unnamed', name: undefined },
    ] }));
    const source = createOpenRouterModelSource({ fetch });
    expect(await source.list()).toEqual([
      { harness: 'opencode', model: 'openrouter/google/gemini', vendor: 'Google', label: 'Gemini: Pro', efforts: ['low', 'medium', 'high'] },
      { harness: 'opencode', model: 'openrouter/other/model', vendor: 'other', label: 'Whole name', efforts: ['low', 'medium', 'high'] },
      { harness: 'opencode', model: 'openrouter/other/unnamed', vendor: 'other', label: 'other/unnamed', efforts: ['low', 'medium', 'high'] },
    ]);
    expect(fetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', { signal: expect.any(AbortSignal) });
  });

  it('caches within the TTL and refetches when it expires', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response());
    const source = createOpenRouterModelSource({ fetch, ttlMs: 100 });
    const first = await source.list();
    vi.advanceTimersByTime(99);
    expect(await source.list()).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(await source.list()).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([0, 60_000])('re-arms the cache after a failed refresh with TTL %i', async (ttlMs) => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response()).mockRejectedValue(new Error('offline'));
    const warn = vi.fn();
    const source = createOpenRouterModelSource({ fetch, ttlMs, logger: { warn } });
    const first = await source.list();
    vi.advanceTimersByTime(ttlMs);
    expect(await source.list()).toEqual(first);
    vi.advanceTimersByTime(ttlMs === 0 ? 1 : ttlMs - 1);
    expect(await source.list()).toEqual(first);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(ttlMs === 0 ? 29_999 : 1);
    expect(await source.list()).toEqual(first);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(['network', 'http', 'shape'])('throws on first-fetch %s failure and permits a retry', async (failure) => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>();
    if (failure === 'network') fetch.mockRejectedValueOnce(new Error('offline'));
    else fetch.mockResolvedValueOnce(failure === 'http' ? new Response('', { status: 503 }) : Response.json({}));
    fetch.mockResolvedValueOnce(response());
    const source = createOpenRouterModelSource({ fetch });
    await expect(source.list()).rejects.toBeInstanceOf(OpenRouterUnavailableError);
    await expect(source.list()).rejects.toBeInstanceOf(OpenRouterUnavailableError);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(await source.list()).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one pending fetch across concurrent first callers', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const source = createOpenRouterModelSource({ fetch });
    const first = source.list();
    const second = source.list();
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(response());
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
