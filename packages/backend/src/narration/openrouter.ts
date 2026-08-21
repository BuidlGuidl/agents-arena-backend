import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText } from 'ai';

import type { NarrationInput } from './window.js';

export type Narrate = (input: NarrationInput, signal: AbortSignal) => Promise<string>;

export interface OpenRouterNarratorOptions {
  apiKey: string;
  model: string;
}

export function createOpenRouterNarrator(options: OpenRouterNarratorOptions): Narrate {
  const openrouter = createOpenRouter({ apiKey: options.apiKey });
  const model = openrouter(options.model);

  return async (input, signal) => {
    const result = await generateText({
      model,
      system: input.system,
      prompt: input.prompt,
      maxOutputTokens: 80,
      // Description, not creativity: low temperature cuts the colour commentary.
      temperature: 0.3,
      abortSignal: signal,
    });
    const text = firstSentences(result.text.trim(), 2);
    if (text.length === 0) throw new Error('OpenRouter returned empty narration text');
    return text;
  };
}

// The prompt asks for at most two sentences; this is the backstop when the model runs long.
export function firstSentences(text: string, count: number): string {
  // A sentence ends at .!? followed by whitespace, so "Challenge12.sol" stays whole.
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.slice(0, count).join(' ').trim();
}
