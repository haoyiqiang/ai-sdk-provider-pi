/**
 * Custom provider configuration example.
 *
 * Usage: npx tsx examples/custom-provider.ts
 */

import { createPi } from '../src/index.js';
import { AuthStorage } from '@earendil-works/pi-coding-agent';
import { generateText } from 'ai';

async function main() {
  // Custom provider with explicit AuthStorage
  const authStorage = AuthStorage.create();

  const pi = createPi({
    authStorage,
    logger: {
      debug: (msg: string) => console.debug(`[DEBUG] ${msg}`),
      info: () => {}, // Suppress info logs
      warn: (msg: string) => console.warn(`[WARN] ${msg}`),
      error: (msg: string) => console.error(`[ERROR] ${msg}`),
    },
  });

  // Try a Claude model
  const claudeModel = pi('anthropic/claude-haiku-4');

  try {
    console.log('=== Claude Haiku ===\n');

    const { text, usage, providerMetadata } = await generateText({
      model: claudeModel,
      prompt: '用一句话介绍你自己。',
    });

    console.log(text);
    console.log();
    console.log(`Tokens: in=${usage.inputTokens ?? 'N/A'}, out=${usage.outputTokens ?? 'N/A'}`);
    if (providerMetadata) {
      console.log(`Provider: ${(providerMetadata as any).provider?.value ?? 'N/A'}`);
      console.log(`Model: ${(providerMetadata as any).responseModel?.value ?? 'N/A'}`);
    }
  } catch (error) {
    console.error('Claude model error:', error);
  } finally {
    (claudeModel as any).dispose();
  }

  // Try switching to a different model
  console.log('\n---\n');

  const openaiModel = pi('gpt-4o');

  try {
    console.log('=== GPT-4o ===\n');

    const { text, usage } = await generateText({
      model: openaiModel,
      prompt: '用一句话介绍你自己。',
    });

    console.log(text);
    console.log();
    console.log(`Tokens: in=${usage.inputTokens ?? 'N/A'}, out=${usage.outputTokens ?? 'N/A'}`);
  } catch (error) {
    console.error('OpenAI model error:', error);
  } finally {
    (openaiModel as any).dispose();
  }
}

main();
