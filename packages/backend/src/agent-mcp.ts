import { originValidation } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, ProtocolError, Server, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import { z } from 'zod';

import { NotInRunError, requireLane, resolveAgentToken, type AgentIdentityRecord, type AgentTokens } from './agent-auth.js';
import type { AgentIngest } from './agent-ingest.js';
import { joinToolSchema, noteToolSchema } from './agent-input.js';
import { AgentRateLimitError } from './agent-limits.js';
import { challengeIdSchema, type AgentProgress } from './agent-progress.js';
import { bearerToken } from './auth.js';
import { AGENT_MCP_TOOLS, type EntrantStatus, type JoinRunRequest, type JoinRunResponse } from './contract.js';
import { resolveSiteUrl } from './config.js';
import { inboxAfterSchema, type AgentInbox } from './inbox.js';
import { JoinConflictError, RemovedWalletError, RunNotFoundError, type RunManager } from './run-manager.js';
import { JoinAuthenticationError } from './signed-message.js';

const inputSchemas = {
  join_run: joinToolSchema,
  get_task: z.strictObject({}),
  set_current_challenge: z.strictObject({ challengeId: challengeIdSchema }),
  post_note: noteToolSchema,
  read_inbox: z.strictObject({ after: inboxAfterSchema }),
};

function inputSchema(schema: z.ZodObject): Tool['inputSchema'] {
  const { $schema, ...jsonSchema } = z.toJSONSchema(schema, { io: 'input' });
  // The SDK caps its recursive JSON type; Zod's JSON Schema type has no depth cap.
  return { ...jsonSchema, type: 'object' } as Tool['inputSchema'];
}
type NamedTools<Names extends readonly string[]> = { [Index in keyof Names]: Tool & { name: Names[Index] } };
const tools = [
  {
    name: 'join_run',
    description: 'Call to join an Agents Arena race before asking for its briefing. Pass your display name. If you know them, pass the harness and model you run on and your reasoning effort; the board shows them as declared by you.',
    inputSchema: inputSchema(inputSchemas.join_run),
  },
  {
    name: 'get_task',
    description: 'Call after joining to read the Agents Arena briefing and check whether the race has started.',
    inputSchema: inputSchema(inputSchemas.get_task),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_current_challenge',
    description: 'Call when you start working on a challenge in the Agents Arena race and pass its id, 1 to 12. This tells the board which challenge your lane is on.',
    inputSchema: inputSchema(inputSchemas.set_current_challenge),
  },
  {
    name: 'post_note',
    description: 'Call between steps in Agents Arena to say what you are doing and how you are approaching it, and after each attempt to describe the outcome. Optionally set your status: working, idle, blocked, or done.',
    inputSchema: inputSchema(inputSchemas.post_note),
  },
  {
    name: 'read_inbox',
    description: 'Call between steps or when inbox.unread is positive to read messages from the Agents Arena race operator; ' +
      'pass the cursor from your last result, or omit it to read from the start.',
    inputSchema: inputSchema(inputSchemas.read_inbox),
  },
] satisfies NamedTools<typeof AGENT_MCP_TOOLS>;
// Check only the integer shape here. Range errors follow the lane check below.
// z.int() would reject unsafe integers before that check.
const validators = new Map<string, z.ZodType<Record<string, unknown>>>(Object.entries({
  ...inputSchemas,
  set_current_challenge: z.strictObject({ challengeId: z.number().refine(Number.isInteger) }),
}));
const reporting = 'Call post_note between steps to say what you are doing and how you are approaching the challenge, ' +
  'and after each attempt, success or failure. Call set_current_challenge when you start a challenge. ' +
  'Call read_inbox between steps; inbox.unread tells you when there is something.';
const waiting = 'The race has not started. Ask the person running you to say "go" when it starts, ' +
  'or call get_task again in about thirty seconds. Do not start work until task is set.';
const serverInstructions = 'These tools are for racing in Agents Arena, a capture-the-flag race between coding agents scored on-chain. ' +
  'Use them only when the person running you asks you to join or race. Do not call them during unrelated work.';

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
  siteUrl?: string;
}

export function mountAgentMcp(app: FastifyInstance, options: AgentMcpOptions): void {
  const { manager, inbox, ingest, progress, agentTokens } = options;
  const siteUrl = resolveSiteUrl(options.publicUrl, [], options.siteUrl);
  const handler = createMcpHandler((context) => {
    const token = bearerToken(context.requestInfo?.headers.get('authorization') ?? undefined);
    const inspected = token === undefined ? { state: 'unknown' } as const : agentTokens.inspect(token);
    const identity = inspected.state === 'live' ? inspected.record
      : token === undefined ? undefined : resolveAgentToken(token);
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
      if (identity === undefined) {
        const error = inspected.state === 'expired'
          ? `This arena token expired on ${inspected.expiresAt.slice(0, 10)}. Ask the person running you to follow ${siteUrl}/arena/join ` +
            "to create a new one and update this server's Authorization header."
          : `This MCP server has no valid arena token. Ask the person running you to follow ${siteUrl}/arena/join, ` +
            "which explains how to create one, and to add it to this server's Authorization header.";
        return result({ error }, true);
      }
      try {
        const input = request.params.arguments ?? {};
        const parsed = validator.safeParse(input);
        if (!parsed.success) {
          throw new ProtocolError(-32602, `Invalid arguments for ${name}: ${parsed.error.issues[0]?.message}`);
        }
        const args = parsed.data;
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
