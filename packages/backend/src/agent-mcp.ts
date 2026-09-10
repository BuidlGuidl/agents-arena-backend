import { originValidation } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, fromJsonSchema, ProtocolError, Server, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';

import { NotInRunError, requireLane, resolveAgentToken, type AgentIdentityRecord, type AgentTokens } from './agent-auth.js';
import type { AgentIngest } from './agent-ingest.js';
import { AgentRateLimitError } from './agent-limits.js';
import type { AgentProgress } from './agent-progress.js';
import { bearerToken } from './auth.js';
import { AGENT_MCP_TOOLS, type EntrantStatus, type JoinRunRequest, type JoinRunResponse } from './contract.js';
import { CHALLENGE_COUNT } from './ctf/pack.js';
import type { AgentInbox } from './inbox.js';
import { JoinConflictError, RemovedWalletError, RunNotFoundError, type RunManager } from './run-manager.js';
import { JoinAuthenticationError } from './signed-message.js';

const shortText = { type: 'string', minLength: 1, maxLength: 80 } as const;
type NamedTools<Names extends readonly string[]> = { [Index in keyof Names]: Tool & { name: Names[Index] } };
const tools = [
  {
    name: 'join_run',
    description: 'Call to join a race before asking for its briefing.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['name', 'harness', 'model'],
      properties: {
        runId: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 40 },
        harness: shortText, model: shortText, effort: shortText,
        url: { type: 'string', format: 'uri', pattern: '^[hH][tT][tT][pP][sS]?://', maxLength: 200 },
      },
    },
  },
  {
    name: 'get_task',
    description: 'Call after joining to read the briefing and check whether the race has started.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'report_progress',
    description: 'Call when you switch to another challenge.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['challengeId'],
      properties: { challengeId: { type: 'integer', minimum: 1, maximum: CHALLENGE_COUNT } },
    },
  },
  {
    name: 'post_note',
    description: 'Call after each attempt to describe the outcome and optionally set your status.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['text'],
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 4000 },
        status: { type: 'string', enum: ['working', 'idle', 'blocked', 'done'] },
      },
    },
  },
  {
    name: 'read_inbox',
    description: 'Call between steps or when inbox.unread is positive; ' +
      'pass the cursor from your last result, or omit it to read from the start.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 } },
    },
  },
] satisfies NamedTools<typeof AGENT_MCP_TOOLS>;
const validators = new Map(tools.map((tool) => {
  // Validate the argument shape first; challenge bounds get an actionable tool result after the lane check.
  const schema = tool.name === 'report_progress'
    ? { ...tool.inputSchema, properties: { challengeId: { type: 'integer' } } }
    : tool.inputSchema;
  return [String(tool.name), fromJsonSchema<Record<string, unknown>>(schema)];
}));
const reporting = 'Call report_progress when you switch challenge. ' +
  'Call post_note after each attempt, success or failure, and read_inbox between steps; ' +
  'inbox.unread tells you when there is something.';

const joinErrorMessages = new Map<new (...args: never[]) => Error, (error: Error) => string>([
  [JoinConflictError, (error) => error.message.startsWith('Already racing in run ')
    ? `${error.message}. Finish or leave that race first.`
    : `${error.message}. Choose an open run and call join_run again.`],
  [RunNotFoundError, (error) => `${error.message}. Choose an open run and call join_run again.`],
  [RemovedWalletError, (error) => `${error.message}. Join another run.`],
  [JoinAuthenticationError, () => 'Joining requires a wallet token. Ask the person running you to register and configure it.'],
]);

interface AgentMcpOptions {
  agentTokens: AgentTokens;
  manager: RunManager;
  ingest: AgentIngest;
  inbox: AgentInbox;
  progress: AgentProgress;
  join: (identity: AgentIdentityRecord, input: JoinRunRequest) => Promise<JoinRunResponse>;
  publicUrl: string;
}

export function mountAgentMcp(app: FastifyInstance, options: AgentMcpOptions): void {
  const { manager, inbox, ingest, progress, agentTokens } = options;
  const publicUrl = options.publicUrl.replace(/\/$/, '');
  const handler = createMcpHandler((context) => {
    const token = bearerToken(context.requestInfo?.headers.get('authorization') ?? undefined);
    const identity = token === undefined ? undefined : resolveAgentToken(token, agentTokens);
    // Server is deprecated in the installed SDK, but preserves JSON-RPC server errors.
    // McpServer catches unexpected failures as tool errors.
    const server = new Server({ name: 'arena', version: '1.0.0' }, {
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
      if (identity === undefined) {
        return result({ error: `No valid arena token. Ask the person running you to register at ${publicUrl}/arena/join ` +
          "and put the token in this MCP server's Authorization header." }, true);
      }
      try {
        const input = request.params.arguments ?? {};
        const parsed = await validator['~standard'].validate(input);
        if (parsed.issues !== undefined) {
          throw new ProtocolError(-32602, `Invalid arguments for ${name}: ${parsed.issues[0]?.message}`);
        }
        const args = parsed.value;
        if (name === 'join_run' && typeof args.url === 'string' && !URL.canParse(args.url)) {
          throw new ProtocolError(-32602, 'url must be a valid http or https URL');
        }
        let output: Record<string, unknown> = {};
        let lane;
        if (name === 'join_run') {
          const joined = await options.join(identity, args as unknown as JoinRunRequest);
          lane = { runId: joined.run.id, entrantId: joined.entrantId };
          output = { entrantId: joined.entrantId, message: 'You are in. Call get_task for the briefing.' };
        } else {
          lane = requireLane(identity);
          if (name === 'report_progress' && (Number(args.challengeId) < 1 || Number(args.challengeId) > CHALLENGE_COUNT)) {
            return result({ error: `Challenge ${args.challengeId} is not in this race. Call get_task for the valid ids.` }, true);
          }
          switch (name) {
            case 'get_task': {
              const task = manager.agentTask(lane.runId, lane.entrantId);
              output = { ...task, ...(task.task === null ? {} : { instructions: reporting }) };
              break;
            }
            case 'report_progress': output = progress.announce(lane, args); break;
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
        if (error instanceof NotInRunError) return result({ error: 'Not in a run. Call join_run first.' }, true);
        if (error instanceof AgentRateLimitError) {
          return result({ error: `Too fast. Try again in ${error.retryAfter} seconds.` }, true);
        }
        if (name === 'join_run') {
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
