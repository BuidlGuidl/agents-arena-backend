import { describe, expect, it } from 'vitest';

import { resolveListenHost } from '../src/config.js';

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
