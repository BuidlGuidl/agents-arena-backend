export function resolveListenHost(value = process.env.ARENA_HOST): string {
  return value?.trim() || '127.0.0.1';
}

export const DEFAULT_NARRATION_MODEL = 'anthropic/claude-haiku-4.5';
export const DEFAULT_NARRATION_MIN_MS = 10_000;
export const DEFAULT_NARRATION_MAX_MS = 90_000;

const NARRATION_ON_VALUES = new Set(['', 'on', 'true', '1', 'yes']);
const NARRATION_OFF_VALUES = new Set(['off', 'false', '0', 'no']);

export class InvalidNarrationConfigError extends Error {}

export interface ConfigLogger {
  warn(message: string): void;
}

export interface NarrationConfig {
  enabled: boolean;
  apiKey?: string;
  model: string;
  minMs: number;
  maxMs: number;
}

export function resolveNarrationConfig(
  env: NodeJS.ProcessEnv = process.env,
  logger: ConfigLogger = console,
): NarrationConfig {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  const model = env.ARENA_NARRATION_MODEL?.trim() || DEFAULT_NARRATION_MODEL;
  const switchValue = env.ARENA_NARRATION?.trim().toLowerCase();
  const recognisedOn = switchValue === undefined || NARRATION_ON_VALUES.has(switchValue);
  const recognisedOff = switchValue !== undefined && NARRATION_OFF_VALUES.has(switchValue);
  const switchedOff = recognisedOff || !recognisedOn;
  if (switchValue !== undefined && !recognisedOn && !recognisedOff) {
    logger.warn(
      `ARENA_NARRATION has unrecognised value "${switchValue}"; narration is disabled.`,
    );
  }
  const enabled = !switchedOff && apiKey !== undefined && apiKey.length > 0;
  if (!enabled) {
    return {
      enabled: false,
      ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
      model,
      minMs: DEFAULT_NARRATION_MIN_MS,
      maxMs: DEFAULT_NARRATION_MAX_MS,
    };
  }
  const minMs = narrationDuration(env.ARENA_NARRATION_MIN_MS, DEFAULT_NARRATION_MIN_MS, 'MIN');
  const maxMs = narrationDuration(env.ARENA_NARRATION_MAX_MS, DEFAULT_NARRATION_MAX_MS, 'MAX');
  if (maxMs < minMs) {
    throw new InvalidNarrationConfigError(
      'ARENA_NARRATION_MAX_MS must be at least ARENA_NARRATION_MIN_MS',
    );
  }
  return {
    enabled: true,
    apiKey,
    model,
    minMs,
    maxMs,
  };
}

function narrationDuration(value: string | undefined, fallback: number, label: 'MIN' | 'MAX'): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidNarrationConfigError(
      `ARENA_NARRATION_${label}_MS must be an integer of at least 1`,
    );
  }
  return parsed;
}
