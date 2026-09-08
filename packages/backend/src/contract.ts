export * from '../../../contract/arena-types.js';

import { JOIN_MESSAGE_TEMPLATE, type RunState } from '../../../contract/arena-types.js';

export const TERMINAL_RUN_STATES: RunState[] = ['stopping', 'finished', 'failed'];

export function joinMessage(input: { runId: string; address: string; nonce: string }): string {
  return JOIN_MESSAGE_TEMPLATE.replace('{runId}', () => input.runId)
    .replace('{address}', () => input.address).replace('{nonce}', () => input.nonce);
}
