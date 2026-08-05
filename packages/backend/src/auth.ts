import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';

import { SESSION_COOKIE, type SiweLogin } from './siwe.js';

// Reads stay open for spectators; everything that drives a run is operator-only.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// The login pair cannot require a credential: one mints the session, the other
// destroys it. The agent route carries its own per-entrant bearer, checked in
// the handler. Everything else that mutates goes through the gate.
const OPEN_ROUTES = new Set(['/auth/verify', '/auth/logout', '/agent/progress']);

export class MissingOperatorTokenError extends Error {}

export interface OperatorAuthOptions {
  token: string;
  login?: SiweLogin;
}

/**
 * One shared operator token or one wallet session on every mutating route. Neither
 * credential travels in a query string, so both stay out of logs and out of SSE
 * reconnect URLs.
 */
export function operatorAuth(options: OperatorAuthOptions): onRequestAsyncHookHandler {
  // Trimmed on both sides: the header is trimmed on the way in, so a configured
  // token with stray whitespace would otherwise start a server nothing can reach.
  const configured = options.token.trim();
  if (configured.length === 0) {
    throw new MissingOperatorTokenError('Operator token must not be empty or whitespace');
  }
  const expected = digest(configured);

  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (READ_METHODS.has(request.method)) return undefined;
    if (OPEN_ROUTES.has(routePath(request))) return undefined;
    if (matches(expected, bearerToken(request.headers.authorization))) return undefined;
    if (options.login?.session(sessionCookie(request.headers.cookie)) !== undefined) return undefined;
    void reply
      .status(401)
      .header('WWW-Authenticate', 'Bearer realm="agents-arena"')
      .send({ error: 'Operator token required' });
    return reply;
  };
}

export function sessionCookie(header: string | undefined): string | undefined {
  return readCookie(header, SESSION_COOKIE);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface CookieAttributes {
  maxAgeSeconds: number;
  secure: boolean;
}

/**
 * `SameSite=Strict` is the CSRF defence: the browser withholds the cookie on any
 * cross-site request, so a hostile page cannot stop a race with the operator's
 * own session. `HttpOnly` keeps it away from page scripts.
 */
export function serializeSessionCookie(value: string, attributes: CookieAttributes): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${attributes.maxAgeSeconds}`,
  ];
  if (attributes.secure) parts.push('Secure');
  return parts.join('; ');
}

// A plain-http localhost demo still has to work, so Secure follows the host.
export function isSecureRequest(request: FastifyRequest): boolean {
  return !isLoopbackHost((request.headers.host ?? '').toLowerCase());
}

// An IPv6 literal keeps its brackets in the Host header, so strip those before the
// port rather than splitting on the first colon. All of 127.0.0.0/8 is loopback.
function isLoopbackHost(host: string): boolean {
  const closing = host.indexOf(']');
  const name = host.startsWith('[') && closing > 0
    ? host.slice(1, closing)
    : (host.split(':')[0] ?? '');
  if (name === 'localhost' || name === '::1' || name === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

function routePath(request: FastifyRequest): string {
  const url = request.routeOptions?.url;
  if (url !== undefined) return url;
  const [path] = request.url.split('?');
  return path ?? request.url;
}

export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

// Hashing first keeps the comparison constant time across unequal lengths.
function matches(expected: Buffer, provided: string | undefined): boolean {
  return provided !== undefined && timingSafeEqual(expected, digest(provided));
}
