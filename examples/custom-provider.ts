/**
 * Custom provider configuration example.
 *
 * Usage: cp .env.example .env  # 配置 PI_MODEL_ID 和 API key
 *        npx tsx examples/custom-provider.ts
 */
import 'dotenv/config';
import { createPi } from '../src/index.js';
import { AuthStorage } from '@earendil-works/pi-coding-agent';
import { generateText } from 'ai';

const MODEL_ID = process.env.PI_MODEL_ID ?? 'deepseek-v4-flash';

async function main() {
  // Custom provider with explicit AuthStorage and logger
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

  const model = pi(MODEL_ID);

  try {
    console.log(`=== Custom Provider (model: ${MODEL_ID}) ===\n`);

    const { text, usage, providerMetadata } = await generateText({
      model,
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
    console.error('Model error:', error);
  } finally {
    (model as any).dispose();
  }
}

main();
