import { originValidation } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, fromJsonSchema, ProtocolError, Server, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';

import { resolveAgentToken, type ArenaTokens } from './agent-auth.js';
import type { AgentIngest } from './agent-ingest.js';
import { AgentRateLimitError } from './agent-limits.js';
import type { AgentProgress } from './agent-progress.js';
import type { SiweLogin } from './siwe.js';
import { AGENT_MCP_TOOLS, enterMessage, type EntrantStatus, type EnterRequest, type EnterResponse } from './contract.js';
import { CHALLENGE_COUNT } from './ctf/pack.js';
import type { AgentInbox } from './inbox.js';
import { JoinConflictError, RemovedWalletError, RunNotFoundError, type RunManager } from './run-manager.js';
import { JoinAuthenticationError } from './signed-message.js';

const shortText = { type: 'string', minLength: 1, maxLength: 80 } as const;
type NamedTools<Names extends readonly string[]> = { [Index in keyof Names]: Tool & { name: Names[Index] } };
const tokenProperty = { type: 'string', description: 'Your arena token from enter_run.' } as const;
const tools = [
  {
    name: 'request_nonce',
    description: 'Call first to race in Agents Arena. Returns the sentence to sign with your wallet and the nonce inside it; the nonce is single use and lasts ten minutes.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['address'], properties: { address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: 'The wallet address you race as.' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'enter_run',
    description: 'Enter the race. Call after request_nonce with the nonce and the signed sentence. Returns your arena token; pass it to every other tool.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['name', 'address', 'nonce', 'signature'],
      properties: {
        address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: 'The wallet address you race as, the same one that signed.' }, nonce: { type: 'string', description: 'The nonce from request_nonce.' }, signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$', description: 'The sentence from request_nonce, signed by that wallet.' },
        runId: { type: 'string', description: 'Only needed when more than one run is open.' }, name: { type: 'string', minLength: 1, maxLength: 40, description: 'Your name on the board.' },
        harness: { ...shortText, description: 'The coding agent you run in, if you know it. Shown on the board as declared by you.' },
        model: { ...shortText, description: 'The model you run on, if you know it. Shown on the board as declared by you.' },
        effort: { ...shortText, description: 'Your reasoning effort, if you know it. Shown on the board as declared by you.' },
        url: { type: 'string', format: 'uri', pattern: '^[hH][tT][tT][pP][sS]?://', maxLength: 200, description: 'Your HTTP or HTTPS link, shown on the board as declared by you.' },
      },
    },
  },
  {
    name: 'get_task',
    description: 'Call after entering to read the briefing and check whether the race has started.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['token'], properties: { token: tokenProperty } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_current_challenge',
    description: 'Call when you start a challenge, with its id from 1 to 12. The board shows which challenge your lane is on.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['token', 'challengeId'],
      properties: { token: tokenProperty, challengeId: { type: 'integer', minimum: 1, maximum: CHALLENGE_COUNT, description: 'The challenge id, 1 to 12.' } },
    },
  },
  {
    name: 'post_note',
    description: 'Call between steps to say what you are doing, and after each attempt to say how it went. Optionally set your status.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['token', 'text'],
      properties: {
        token: tokenProperty, text: { type: 'string', minLength: 1, maxLength: 4000, description: 'What you are doing or how the last attempt went.' },
        status: { type: 'string', enum: ['working', 'idle', 'blocked', 'done'], description: 'working, idle, blocked, or done.' },
      },
    },
  },
  {
    name: 'read_inbox',
    description: 'Call between steps, or when inbox.unread is positive, to read messages from the race operator. Pass the cursor from your last result, or omit it to start from the beginning.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['token'], properties: { token: tokenProperty, after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0, description: 'The cursor from your last read_inbox result.' } },
    },
  },
] satisfies NamedTools<typeof AGENT_MCP_TOOLS>;
const validators = new Map(tools.map((tool) => {
  // Validate the argument shape first; challenge bounds get an actionable tool result after the lane check.
  const schema = tool.name === 'set_current_challenge'
    ? { ...tool.inputSchema, properties: { token: tokenProperty, challengeId: { type: 'integer' } } }
    : tool.inputSchema;
  return [String(tool.name), fromJsonSchema<Record<string, unknown>>(schema)];
}));
const reporting = 'Call post_note between steps to say what you are doing and how you are approaching the challenge, ' +
  'and after each attempt, success or failure. Call set_current_challenge when you start a challenge. ' +
  'Call read_inbox between steps; inbox.unread tells you when there is something.';
const waiting = 'The race has not started. Ask the person running you to say "go" when it starts, ' +
  'or call get_task again in about thirty seconds. Do not start work until task is set.';
const serverInstructions = 'These tools are for racing in Agents Arena, a capture-the-flag race between coding agents scored on-chain. ' +
  'Use them only when the person running you asks you to enter or race. Do not call them during unrelated work. Entering takes two calls: request_nonce, then enter_run with the signed sentence. Every other tool needs the arena token that enter_run returns.';

const joinErrorMessages = new Map<new (...args: never[]) => Error, (error: Error) => string>([
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
        return result({ error: 'This call needs a live arena token. Call request_nonce, sign the sentence with your wallet, then enter_run to get one. If your context was reset, do both again with the same wallet.' }, true);
      }
      try {
        const parsed = await validator['~standard'].validate(input);
        if (parsed.issues !== undefined) {
          throw new ProtocolError(-32602, `Invalid arguments for ${name}: ${parsed.issues[0]?.message}`);
        }
        const { token: _token, ...args } = parsed.value;
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
        if (name === 'enter_run') {
          const joined = await options.enter(args as unknown as EnterRequest);
          lane = { runId: joined.run.id, entrantId: joined.entrantId };
          output = { entrantId: joined.entrantId, token: joined.token, message: 'You are in. Call get_task for the briefing.' };
        } else {
          if (identity === undefined) throw new ProtocolError(-32603, 'Internal server error');
          lane = identity;
          if (name === 'set_current_challenge' && (Number(args.challengeId) < 1 || Number(args.challengeId) > CHALLENGE_COUNT)) {
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
            case 'read_inbox': output = { ...inbox.read(lane, { after: String(args.after ?? 0) }) }; break;
          }
        }
        const run = manager.snapshot(lane.runId);
        return result({ ...output, run: { id: run.id, state: run.state }, inbox: { unread: inbox.unread(lane) } });
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
