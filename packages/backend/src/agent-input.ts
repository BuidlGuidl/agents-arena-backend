import { z } from 'zod';

import { AGENT_STRING_LIMIT } from './agent-limits.js';

const declaredTextSchema = z.string().max(80);
const runIdSchema = z.string();
const joinUrlSchema = z.string().max(200)
  .refine(URL.canParse, { error: 'Invalid url' })
  .refine((value) => /^https?:/i.test(value), { error: 'url must use http or https' })
  .meta({ format: 'uri' });
const joinFields = {
  runId: runIdSchema.optional(),
  name: z.string().min(1).max(40),
  harness: declaredTextSchema.optional(),
  model: declaredTextSchema.optional(),
  effort: declaredTextSchema.optional(),
  url: joinUrlSchema.optional(),
};

// HTTP has always accepted empty metadata and required a nonempty runId when supplied.
export const httpJoinSchema = z.strictObject({ ...joinFields, runId: runIdSchema.min(1).optional() });
const mcpDeclaredTextSchema = declaredTextSchema.min(1).optional();
export const joinToolSchema = z.strictObject({
  ...joinFields,
  harness: mcpDeclaredTextSchema,
  model: mcpDeclaredTextSchema,
  effort: mcpDeclaredTextSchema,
  url: joinUrlSchema.regex(/^[hH][tT][tT][pP][sS]?:\/\//).optional(),
});

export const entrantStatusSchema = z.enum(['working', 'idle', 'blocked', 'done']);
export const agentMessageTextSchema = z.string().max(AGENT_STRING_LIMIT);
// HTTP events allow empty messages up to the event string limit; MCP notes are shorter.
export const noteToolSchema = z.strictObject({
  text: agentMessageTextSchema.min(1).max(4000),
  status: entrantStatusSchema.optional(),
});
