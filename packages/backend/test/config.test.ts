import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_NARRATION_MAX_MS,
  DEFAULT_NARRATION_MIN_MS,
  DEFAULT_NARRATION_MODEL,
  resolveListenHost,
  resolveNarrationConfig,
} from '../src/config.js';

describe('resolveListenHost', () => {
  it.each([
    [undefined, '127.0.0.1'],
    ['', '127.0.0.1'],
    ['   ', '127.0.0.1'],
    ['  0.0.0.0  ', '0.0.0.0'],
  ])('resolves %j to %s', (value, expected) => {
    expect(resolveListenHost(value)).toBe(expected);
  });
});

describe('resolveNarrationConfig', () => {
  it('uses the documented defaults and stays off without an API key', () => {
    expect(resolveNarrationConfig({})).toEqual({
      enabled: false,
      model: DEFAULT_NARRATION_MODEL,
      minMs: DEFAULT_NARRATION_MIN_MS,
      maxMs: DEFAULT_NARRATION_MAX_MS,
    });
  });

  it('enables with an API key and parses overrides', () => {
    expect(resolveNarrationConfig({
      OPENROUTER_API_KEY: ' key ',
      ARENA_NARRATION_MODEL: ' model-id ',
      ARENA_NARRATION_MIN_MS: '10',
      ARENA_NARRATION_MAX_MS: '20',
    })).toEqual({ enabled: true, apiKey: 'key', model: 'model-id', minMs: 10, maxMs: 20 });
  });

  it.each(['off', 'OFF', 'false', 'False', '0', 'no', 'NO'])('treats %s as off before validating durations', (value) => {
    expect(resolveNarrationConfig({
      OPENROUTER_API_KEY: 'key',
      ARENA_NARRATION: value,
      ARENA_NARRATION_MIN_MS: 'invalid',
      ARENA_NARRATION_MAX_MS: '0',
    }).enabled).toBe(false);
  });

  it.each(['on', 'ON', 'true', 'True', '1', 'yes', 'YES', ''])('treats %j as on', (value) => {
    expect(resolveNarrationConfig({
      OPENROUTER_API_KEY: 'key',
      ARENA_NARRATION: value,
    }).enabled).toBe(true);
  });

  it('warns and disables narration for an unknown switch value', () => {
    const logger = { warn: vi.fn() };

    expect(resolveNarrationConfig({
      OPENROUTER_API_KEY: 'key',
      ARENA_NARRATION: 'sometimes',
      ARENA_NARRATION_MIN_MS: 'invalid',
    }, logger).enabled).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'ARENA_NARRATION has unrecognised value "sometimes"; narration is disabled.',
    );
  });

  it('rejects inverted bounds while narration is enabled', () => {
    expect(() => resolveNarrationConfig({
      OPENROUTER_API_KEY: 'key',
      ARENA_NARRATION_MIN_MS: '20', ARENA_NARRATION_MAX_MS: '10',
    })).toThrow('MAX_MS');
  });

  it.each(['0', '-1', '1.5'])('rejects a duration below one positive integer: %s', (value) => {
    expect(() => resolveNarrationConfig({
      OPENROUTER_API_KEY: 'key',
      ARENA_NARRATION_MIN_MS: value,
    })).toThrow('at least 1');
  });
});
