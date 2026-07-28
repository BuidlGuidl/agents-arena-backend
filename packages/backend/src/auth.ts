import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';

// Reads stay open for spectators; everything that drives a run is operator-only.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class MissingOperatorTokenError extends Error {}

/**
 * One shared operator token on every mutating route. The token never travels in
 * a query string, so it stays out of logs and out of SSE reconnect URLs.
 */
export function operatorAuth(token: string): onRequestAsyncHookHandler {
  // Trimmed on both sides: the header is trimmed on the way in, so a configured
  // token with stray whitespace would otherwise start a server nothing can reach.
  const configured = token.trim();
  if (configured.length === 0) {
    throw new MissingOperatorTokenError('Operator token must not be empty or whitespace');
  }
  const expected = digest(configured);

  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (READ_METHODS.has(request.method)) return undefined;
    if (matches(expected, bearerToken(request.headers.authorization))) return undefined;
    void reply
      .status(401)
      .header('WWW-Authenticate', 'Bearer realm="agents-arena"')
      .send({ error: 'Operator token required' });
    return reply;
  };
}

function bearerToken(header: string | undefined): string | undefined {
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
