import { describe, expect, it, afterEach } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

import { createServer, type ArenaServer } from '../src/server.js';
import {
  InvalidOperatorAddressError,
  MissingSiweDomainError,
  SESSION_COOKIE,
  SiweLogin,
} from '../src/siwe.js';

const servers: ArenaServer[] = [];
const OPERATOR_TOKEN = 'test-operator-token';
const HOST = 'arena.test';
const operator = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const stranger = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async ({ app }) => app.close()));
});

function startServer(overrides: { addresses?: string[]; domains?: string[]; sessionTtlMs?: number } = {}): ArenaServer {
  const server = createServer({
    dbPath: ':memory:',
    operatorToken: OPERATOR_TOKEN,
    siwe: {
      operatorAddresses: overrides.addresses ?? [operator.address],
      domains: overrides.domains ?? [HOST],
      ...(overrides.sessionTtlMs === undefined ? {} : { sessionTtlMs: overrides.sessionTtlMs }),
    },
  });
  servers.push(server);
  return server;
}

async function nonceFrom(server: ArenaServer): Promise<string> {
  const response = await server.app.inject({ method: 'GET', url: '/auth/nonce', headers: { host: HOST } });
  expect(response.statusCode).toBe(200);
  return (response.json() as { nonce: string }).nonce;
}

async function signIn(
  server: ArenaServer,
  options: { account?: typeof operator; domain?: string; nonce?: string } = {},
): Promise<{ statusCode: number; cookie: string | undefined; body: unknown }> {
  const account = options.account ?? operator;
  const nonce = options.nonce ?? await nonceFrom(server);
  const message = createSiweMessage({
    address: account.address,
    chainId: 8453,
    domain: options.domain ?? HOST,
    nonce,
    uri: `https://${options.domain ?? HOST}/`,
    version: '1',
  });
  const signature = await account.signMessage({ message });
  const response = await server.app.inject({
    method: 'POST',
    url: '/auth/verify',
    headers: { host: HOST },
    payload: { message, signature },
  });
  const setCookie = response.headers['set-cookie'];
  return {
    statusCode: response.statusCode,
    cookie: Array.isArray(setCookie) ? setCookie[0] : setCookie,
    body: response.json(),
  };
}

function sessionValue(setCookie: string | undefined): string {
  const value = /arena_operator=([^;]*)/.exec(setCookie ?? '')?.[1];
  if (value === undefined) throw new Error('Response carried no session cookie');
  return value;
}

describe('operator wallet login', () => {
  it('turns one signed message into a session that drives a run', async () => {
    const server = startServer();

    const login = await signIn(server);
    expect(login.statusCode).toBe(200);
    expect(login.body).toMatchObject({ address: operator.address });
    expect(login.cookie).toContain(`${SESSION_COOKIE}=`);
    expect(login.cookie).toContain('HttpOnly');
    expect(login.cookie).toContain('SameSite=Strict');
    expect(login.cookie).toContain('Secure');

    const cookie = `${SESSION_COOKIE}=${sessionValue(login.cookie)}`;
    const created = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: { host: HOST, cookie },
      payload: { preset: 'fake-duel' },
    });
    expect(created.statusCode).toBe(201);

    const session = await server.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    expect(session.json()).toMatchObject({ authenticated: true, address: operator.address });

    const loggedOut = await server.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(loggedOut.statusCode).toBe(200);
    const afterLogout = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: { host: HOST, cookie },
      payload: { preset: 'fake-duel' },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('drops Secure on a localhost login so the plain-http demo still works', async () => {
    const server = startServer({ domains: ['localhost:4177'] });
    const nonce = await nonceFrom(server);
    const message = createSiweMessage({
      address: operator.address,
      chainId: 8453,
      // The domain is the URI's authority, port included, the way a browser builds it.
      domain: 'localhost:4177',
      nonce,
      uri: 'http://localhost:4177/',
      version: '1',
    });
    const response = await server.app.inject({
      method: 'POST',
      url: '/auth/verify',
      headers: { host: 'localhost:4177' },
      payload: { message, signature: await operator.signMessage({ message }) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).not.toContain('Secure');
  });

  it('keeps the shared token working alongside a session', async () => {
    const server = startServer();
    const created = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: { host: HOST, authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: { preset: 'fake-duel' },
    });
    expect(created.statusCode).toBe(201);
  });

  it('refuses a stranger, a replayed nonce, an unknown nonce, and a foreign domain', async () => {
    const server = startServer();

    const outsider = await signIn(server, { account: stranger });
    expect(outsider.statusCode).toBe(401);
    expect(outsider.body).toEqual({ error: 'Address is not an arena operator' });

    const nonce = await nonceFrom(server);
    const first = await signIn(server, { nonce });
    expect(first.statusCode).toBe(200);
    const replay = await signIn(server, { nonce });
    expect(replay.statusCode).toBe(401);
    expect(replay.body).toEqual({ error: 'Unknown or already used nonce' });

    const invented = await signIn(server, { nonce: 'neverissuedbythisserver' });
    expect(invented.statusCode).toBe(401);

    // The domain is what the wallet showed the operator, so a phishing origin must fail.
    const phishing = await signIn(server, { domain: 'evil.example' });
    expect(phishing.statusCode).toBe(401);
    expect(phishing.body).toEqual({ error: 'Message domain does not match this server' });
  });

  it('accepts a configured domain that differs from the host a proxy presents', async () => {
    const server = startServer({ domains: ['ctf.buidlguidl.com'] });

    const proxied = await signIn(server, { domain: 'ctf.buidlguidl.com' });
    expect(proxied.statusCode).toBe(200);

    const bareHost = await signIn(server, { domain: HOST });
    expect(bareHost.statusCode).toBe(401);
  });

  it('rejects a message whose URI host differs from its domain', async () => {
    const server = startServer();
    const nonce = await nonceFrom(server);
    const message = createSiweMessage({
      address: operator.address,
      chainId: 8453,
      domain: HOST,
      nonce,
      uri: 'https://evil.example/',
      version: '1',
    });
    const response = await server.app.inject({
      method: 'POST',
      url: '/auth/verify',
      headers: { host: HOST },
      payload: { message, signature: await operator.signMessage({ message }) },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Message URI host does not match its domain' });
  });

  it('rejects a SIWE version other than 1', async () => {
    const server = startServer();
    const nonce = await nonceFrom(server);
    const versionOne = createSiweMessage({
      address: operator.address,
      chainId: 8453,
      domain: HOST,
      nonce,
      uri: `https://${HOST}/`,
      version: '1',
    });
    const message = versionOne.replace('Version: 1', 'Version: 2');
    const response = await server.app.inject({
      method: 'POST',
      url: '/auth/verify',
      headers: { host: HOST },
      payload: { message, signature: await operator.signMessage({ message }) },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unsupported SIWE version' });
  });

  it('stops honouring a session once it expires', async () => {
    const server = startServer({ sessionTtlMs: 1 });
    const login = await signIn(server);
    expect(login.statusCode).toBe(200);
    const cookie = `${SESSION_COOKIE}=${sessionValue(login.cookie)}`;

    await new Promise((resolve) => setTimeout(resolve, 5));

    const expired = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: { host: HOST, cookie },
      payload: { preset: 'fake-duel' },
    });
    expect(expired.statusCode).toBe(401);
    const session = await server.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    expect(session.json()).toEqual({ authenticated: false, configured: true });
  });

  it('answers 503 on the login routes when no operator address is configured', async () => {
    const server = startServer({ addresses: [] });

    const nonce = await server.app.inject({ method: 'GET', url: '/auth/nonce', headers: { host: HOST } });
    expect(nonce.statusCode).toBe(503);
    const verify = await server.app.inject({
      method: 'POST',
      url: '/auth/verify',
      headers: { host: HOST },
      payload: { message: 'anything', signature: '0xdead' },
    });
    expect(verify.statusCode).toBe(503);

    // A page reads this to decide whether to offer a sign-in control at all.
    const session = await server.app.inject({ method: 'GET', url: '/auth/session' });
    expect(session.json()).toEqual({ authenticated: false, configured: false });

    // Token-only is still a working arena.
    const created = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: { preset: 'fake-duel' },
    });
    expect(created.statusCode).toBe(201);
  });

  it('refuses to start on an allowlist entry that is not an address', () => {
    expect(() => createServer({
      dbPath: ':memory:',
      operatorToken: OPERATOR_TOKEN,
      siwe: { operatorAddresses: ['0xnot-an-address'] },
    })).toThrow(InvalidOperatorAddressError);
  });

  it('refuses to enable wallet login without a domain allowlist', () => {
    expect(() => new SiweLogin({
      operatorAddresses: [operator.address],
    })).toThrow(MissingSiweDomainError);
  });

  it('rejects an http URI unless the domain is loopback', async () => {
    const server = startServer();
    const nonce = await nonceFrom(server);
    const message = createSiweMessage({
      address: operator.address,
      chainId: 8453,
      domain: HOST,
      nonce,
      uri: `http://${HOST}/`,
      version: '1',
    });
    const response = await server.app.inject({
      method: 'POST',
      url: '/auth/verify',
      headers: { host: HOST },
      payload: { message, signature: await operator.signMessage({ message }) },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Message URI must be https' });
  });
});

// The nonce carries its own MAC and expiry instead of being remembered, so these
// cover what a stored nonce used to give for free.
describe('self-describing nonce', () => {
  function login(overrides: { nonceTtlMs?: number; now?: () => number } = {}): SiweLogin {
    return new SiweLogin({
      operatorAddresses: [operator.address],
      domains: [HOST],
      ...overrides,
    });
  }

  async function attempt(target: SiweLogin, nonce: string): Promise<string> {
    const message = createSiweMessage({
      address: operator.address,
      chainId: 8453,
      domain: HOST,
      nonce,
      uri: `https://${HOST}/`,
      version: '1',
    });
    const result = await target.login({ message, signature: await operator.signMessage({ message }) });
    return result.ok ? 'ok' : result.reason;
  }

  it('is hex and long enough for EIP-4361', () => {
    expect(login().issueNonce()).toMatch(/^[0-9a-f]{60}$/);
  });

  it('refuses a nonce another process minted, a tampered one, and its own once spent', async () => {
    const mine = login();
    const theirs = login();

    expect(await attempt(mine, theirs.issueNonce())).toBe('Unknown or already used nonce');

    const issued = mine.issueNonce();
    const tampered = `${issued.slice(0, 59)}${issued.endsWith('a') ? 'b' : 'a'}`;
    expect(await attempt(mine, tampered)).toBe('Unknown or already used nonce');

    expect(await attempt(mine, issued)).toBe('ok');
    expect(await attempt(mine, issued)).toBe('Unknown or already used nonce');
  });

  it('refuses its own nonce once the deadline it carries has passed', async () => {
    let clock = 1_800_000_000_000;
    const expiring = login({ nonceTtlMs: 60_000, now: () => clock });
    const nonce = expiring.issueNonce();

    clock += 59_000;
    expect(await attempt(expiring, nonce)).toBe('ok');

    const later = login({ nonceTtlMs: 60_000, now: () => clock });
    const second = later.issueNonce();
    clock += 61_000;
    expect(await attempt(later, second)).toBe('Unknown or already used nonce');
  });
});
