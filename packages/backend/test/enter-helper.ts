import type { LightMyRequestResponse } from 'fastify';
import { privateKeyToAccount } from 'viem/accounts';
import { enterMessage, type EnterRequest } from '../src/contract.js';
import type { ArenaServer } from '../src/server.js';

export const racer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
export async function signedEntry(server: ArenaServer, fields: Partial<EnterRequest> = {}, account = racer): Promise<EnterRequest> {
  const nonce = (await server.app.inject({ url: '/auth/nonce' })).json().nonce as string;
  const body = { name: 'Agent', address: account.address, nonce, ...fields };
  return { ...body, signature: fields.signature ?? await account.signMessage({ message: enterMessage(body) }) };
}
export async function enter(server: ArenaServer, fields: Partial<EnterRequest> = {}, account = racer): Promise<LightMyRequestResponse> {
  return server.app.inject({ method: 'POST', url: '/agent/enter', payload: await signedEntry(server, fields, account) });
}
