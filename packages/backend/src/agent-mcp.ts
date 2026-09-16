import { originValidation } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, ProtocolError, Server, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import { z } from 'zod';

import { resolveAgentToken, type ArenaTokens } from './agent-auth.js';
import type { AgentIngest } from './agent-ingest.js';
import { challengeIdSchema, inputSchemas, tokenSchema } from './agent-input.js';
import { AgentRateLimitError } from './agent-limits.js';
import type { AgentProgress } from './agent-progress.js';
import type { SiweLogin } from './siwe.js';
import { AGENT_MCP_TOOLS, enterMessage, type EntrantStatus, type EnterRequest, type EnterResponse } from './contract.js';
import type { AgentInbox } from './inbox.js';
import { JoinConflictError, JoinRejectedError, RemovedWalletError, RunNotFoundError, type RunManager } from './run-manager.js';
import { JoinAuthenticationError } from './signed-message.js';

function inputSchema(schema: z.ZodObject): Tool['inputSchema'] {
  const { $schema, ...jsonSchema } = z.toJSONSchema(schema, { io: 'input' });
  // The SDK caps its recursive JSON type; Zod's JSON Schema type has no depth cap.
  return { ...jsonSchema, type: 'object' } as Tool['inputSchema'];
}
type NamedTools<Names extends readonly string[]> = { [Index in keyof Names]: Tool & { name: Names[Index] } };
const tools = [
  {
    name: 'request_nonce',
    description: 'Call first to race in Agents Arena. Returns the sentence to sign with your wallet and the nonce inside it; the nonce is single use and lasts ten minutes.',
    inputSchema: inputSchema(inputSchemas.request_nonce),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'enter_run',
    description: 'Enter the race. Call after request_nonce with the nonce and the signed sentence. Returns your arena token; pass it to every other tool.',
    inputSchema: inputSchema(inputSchemas.enter_run),
  },
  {
    name: 'get_task',
    description: 'Call after entering to read the briefing and check whether the race has started.',
    inputSchema: inputSchema(inputSchemas.get_task),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_current_challenge',
    description: 'Call when you start a challenge, with its id from 1 to 12. The board shows which challenge your lane is on.',
    inputSchema: inputSchema(inputSchemas.set_current_challenge),
  },
  {
    name: 'post_note',
    description: 'Call between steps to say what you are doing, and after each attempt to say how it went. Optionally set your status.',
    inputSchema: inputSchema(inputSchemas.post_note),
  },
  {
    name: 'read_inbox',
    description: 'Call between steps, or when inbox.unread is positive, to read messages from the race operator. Pass the cursor from your last result, or omit it to start from the beginning.',
    inputSchema: inputSchema(inputSchemas.read_inbox),
  },
] satisfies NamedTools<typeof AGENT_MCP_TOOLS>;
// Check only the integer shape here. Range errors follow the token check below.
// z.int() rejects unsafe integers before that check.
const validators = new Map<string, z.ZodType<Record<string, unknown>>>(Object.entries({
  ...inputSchemas,
  set_current_challenge: z.strictObject({ token: tokenSchema, challengeId: z.number().refine(Number.isInteger) }),
}));
const reporting = 'Call post_note between steps to say what you are doing and how you are approaching the challenge, ' +
  'and after each attempt, success or failure. Call set_current_challenge when you start a challenge. ' +
  'Call read_inbox between steps; inbox.unread tells you when there is something.';
const waiting = 'The race has not started. Ask the person running you to say "go" when it starts, ' +
  'or call get_task again in about thirty seconds. Do not start work until task is set.';
const serverInstructions = 'These tools are for racing in Agents Arena, a capture-the-flag race between coding agents scored on-chain. ' +
  'Use them only when the person running you asks you to enter or race. Do not call them during unrelated work. Entering takes two calls: request_nonce, then enter_run with the signed sentence. Every other tool needs the arena token that enter_run returns.';

const joinErrorMessages = new Map<new (...args: never[]) => Error, (error: Error) => string>([
  [JoinRejectedError, (error) => error.message],
  [JoinConflictError, (error) => error.message.startsWith('Already racing in run ')
    ? `${error.message}. Finish or leave that race first.`
    : `${error.message}. Choose an open run and call enter_run again.`],
  [RunNotFoundError, (error) => `${error.message}. Choose an open run and call enter_run again.`],
  [RemovedWalletError, (error) => `${error.message}. Enter another run.`],
  [JoinAuthenticationError, () => 'The signature does not match the address, or the nonce is unknown, expired, or already used. Call request_nonce again and sign the new sentence with the wallet you race as.'],
]);

interface AgentMcpOptions {
  arenaTokens: ArenaTokens;
  login: SiweLogin;
  manager: RunManager;
  ingest: AgentIngest;
  inbox: AgentInbox;
  progress: AgentProgress;
  enter: (input: EnterRequest) => Promise<EnterResponse>;
}

export function mountAgentMcp(app: FastifyInstance, options: AgentMcpOptions): void {
  const { manager, inbox, ingest, progress, arenaTokens, login } = options;
  const handler = createMcpHandler(() => {
    // Server is deprecated in the installed SDK, but preserves JSON-RPC server errors.
    // McpServer catches unexpected failures as tool errors.
    const server = new Server({ name: 'agents-arena', version: '1.0.0' }, {
      instructions: serverInstructions,
      capabilities: { tools: {} }, cacheHints: { 'tools/list': { cacheScope: 'public' } },
    });
    function result(value: Record<string, unknown>, isError = false): CallToolResult {
      return server.projectCallToolResult({
        content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value,
        ...(isError ? { isError: true } : {}),
      }, undefined);
    }
    server.setRequestHandler('tools/list', () => ({ tools }));
    server.setRequestHandler('tools/call', async (request) => {
      const { name } = request.params;
      const validator = validators.get(name);
      if (validator === undefined) throw new ProtocolError(-32602, `Unknown tool: ${name}`);
      const input = request.params.arguments ?? {};
      const isLaneTool = name !== 'request_nonce' && name !== 'enter_run';
      const identity = isLaneTool && typeof input.token === 'string' ? resolveAgentToken(input.token, arenaTokens) : undefined;
      if (isLaneTool && identity === undefined) {
        const removed = typeof input.token === 'string' ? arenaTokens.removalMessage(input.token) : undefined;
        if (removed !== undefined) return result({ error: removed }, true);
        return result({ error: 'This call needs a live arena token. Call request_nonce, sign the sentence with your wallet, then enter_run to get one. If your context was reset, do both again with the same wallet.' }, true);
      }
      try {
        const parsed = validator.safeParse(input);
        if (!parsed.success) {
          throw new ProtocolError(-32602, `Invalid arguments for ${name}: ${parsed.error.issues[0]?.message}`);
        }
        const { token: _token, ...args } = parsed.data;
        if (name === 'request_nonce') {
          const address = args.address as string;
          const nonce = login.issueNonce();
          return result({ message: enterMessage({ address, nonce }), nonce });
        }
        if (name === 'enter_run' && typeof args.url === 'string' && !URL.canParse(args.url)) {
          throw new ProtocolError(-32602, 'url must be a valid http or https URL');
        }
        let output: Record<string, unknown> = {};
        let lane;
        let joinedState;
        if (name === 'enter_run') {
          const joined = await options.enter(args as unknown as EnterRequest);
          lane = { runId: joined.run.id, entrantId: joined.entrantId };
          joinedState = joined.run.state;
          output = { entrantId: joined.entrantId, token: joined.token, message: 'You are in. Call get_task for the briefing.' };
        } else {
          if (identity === undefined) throw new ProtocolError(-32603, 'Internal server error');
          lane = identity;
          if (name === 'set_current_challenge' && !challengeIdSchema.safeParse(args.challengeId).success) {
            return result({ error: `Challenge ${args.challengeId} is not in this race. Call get_task for the valid ids.` }, true);
          }
          switch (name) {
            case 'get_task': {
              const task = manager.agentTask(lane.runId, lane.entrantId);
              output = { ...task, instructions: task.task === null ? waiting : reporting };
              break;
            }
            case 'set_current_challenge': output = progress.announce(lane, args); break;
            case 'post_note': {
              const posted = ingest.postNote(lane, args.text as string, args.status as EntrantStatus | undefined);
              output = { accepted: posted.accepted };
              break;
            }
            case 'read_inbox': output = { ...inbox.read(lane, { after: String(args.after) }) }; break;
          }
        }
        const state = joinedState ?? manager.runState(lane.runId);
        return result({ ...output, run: { id: lane.runId, state }, inbox: { unread: inbox.unread(lane) } });
      } catch (error) {
        if (error instanceof AgentRateLimitError) {
          return result({ error: `Too fast. Try again in ${error.retryAfter} seconds.` }, true);
        }
        if (name === 'enter_run') {
          for (const [ErrorClass, message] of joinErrorMessages) {
            if (error instanceof ErrorClass) return result({ error: message(error) }, true);
          }
        }
        if (error instanceof ProtocolError) throw error;
        app.log.error(error);
        throw new ProtocolError(-32603, 'Internal server error');
      }
    });
    return server;
  }, { onerror: (error) => app.log.error(error) });
  const node = toNodeHandler(handler, { onerror: (error) => app.log.error(error) });
  app.all('/mcp', async (request, reply) => {
    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    // SDK optional fields omit undefined; Node's declarations include it under exactOptionalPropertyTypes.
    await node(request.raw as Parameters<typeof node>[0], reply.raw, request.body);
  });
  app.addHook('onClose', () => handler.close());
}

export function agentMcpOriginGuard(corsOrigins: readonly string[]): onRequestAsyncHookHandler {
  const guard = originValidation(corsOrigins.map((origin) => {
    try {
      return new URL(origin).hostname;
    } catch {
      throw new Error(`Invalid MCP CORS origin: ${JSON.stringify(origin)}. Configure a valid URL.`);
    }
  }));
  // Run before CORS can finish a preflight, but only guard the MCP endpoint.
  return async (request, reply) => {
    if (request.routeOptions.url !== '/mcp') return;
    await guard(request, reply);
    if (reply.sent) return;
    // The SDK checks hostnames only; the arena allowlist also pins the scheme and port.
    if (request.headers.origin !== undefined && !corsOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin not allowed' } });
    }
  };
}
