import { z } from 'zod';

import { AGENT_STRING_LIMIT } from './agent-limits.js';
import { CHALLENGE_COUNT } from './ctf/pack.js';

// Declared fields are trimmed and non-empty on both doors, so a blank label never reaches the board.
const declaredTextSchema = z.string().trim().min(1).max(80);
const runIdSchema = z.string().describe('Only needed when more than one run is open.');
const enterUrlSchema = z.string().trim().max(200)
  .refine(URL.canParse, { error: 'Invalid url' })
  .refine((value) => /^https?:/i.test(value), { error: 'url must use http or https' })
  .meta({ format: 'uri' });
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const proofFields = {
  address: addressSchema.describe('The wallet address you race as, the same one that signed.'),
  nonce: z.string().describe('The nonce from request_nonce.'),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).describe('The sentence from request_nonce, signed by that wallet.'),
};
const enterFields = {
  ...proofFields,
  runId: runIdSchema.optional().describe('Only needed when more than one run is open.'),
  name: z.string().min(1).max(40).describe('Your name on the board.'),
  harness: declaredTextSchema.optional().describe('The coding agent you run in, if you know it. Shown on the board as declared by you.'),
  model: declaredTextSchema.optional().describe('The model you run on, if you know it. Shown on the board as declared by you.'),
  effort: declaredTextSchema.optional().describe('Your reasoning effort, if you know it. Shown on the board as declared by you.'),
  url: enterUrlSchema.optional().describe('Your HTTP or HTTPS link, shown on the board as declared by you.'),
};

// HTTP requires a nonempty runId when supplied.
export const httpEnterSchema = z.strictObject({ ...enterFields, runId: runIdSchema.min(1).optional().describe(runIdSchema.description!) });
export const enterToolSchema = z.strictObject({
  ...enterFields,
  url: enterUrlSchema.regex(/^[hH][tT][tT][pP][sS]?:\/\//).optional().describe(enterFields.url.description!),
});

export const entrantStatusSchema = z.enum(['working', 'idle', 'blocked', 'done']);
export const agentMessageTextSchema = z.string().max(AGENT_STRING_LIMIT);
export const tokenSchema = z.string().describe('Your arena token from enter_run.');
// HTTP events allow empty messages up to the event string limit; MCP notes are shorter.
export const noteToolSchema = z.strictObject({
  token: tokenSchema,
  text: agentMessageTextSchema.min(1).max(4000).describe('What you are doing or how the last attempt went.'),
  status: entrantStatusSchema.optional().describe('working, idle, blocked, or done.'),
});

export const challengeIdSchema = z.int().min(1).max(CHALLENGE_COUNT).describe('The challenge id, 1 to 12.');
export const inboxAfterSchema = z.int().nonnegative().default(0).describe('The cursor from your last read_inbox result.');
export const inputSchemas = {
  request_nonce: z.strictObject({ address: addressSchema.describe('The wallet address you race as.') }),
  enter_run: enterToolSchema,
  get_task: z.strictObject({ token: tokenSchema }),
  set_current_challenge: z.strictObject({ token: tokenSchema, challengeId: challengeIdSchema }),
  post_note: noteToolSchema,
  read_inbox: z.strictObject({ token: tokenSchema, after: inboxAfterSchema }),
};
