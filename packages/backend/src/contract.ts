export * from '../../../contract/arena-types.js';

import { ENTER_MESSAGE_TEMPLATE, type RunState } from '../../../contract/arena-types.js';

export const TERMINAL_RUN_STATES: RunState[] = ['stopping', 'finished', 'failed'];

export function enterMessage(input: { address: string; nonce: string }): string {
  return ENTER_MESSAGE_TEMPLATE.replace('{address}', () => input.address).replace('{nonce}', () => input.nonce);
}
