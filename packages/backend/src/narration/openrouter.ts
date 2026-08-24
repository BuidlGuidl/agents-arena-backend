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
    const text = result.text.trim();
    if (text.length === 0) throw new Error('OpenRouter returned empty narration text');
    return text;
  };
}
