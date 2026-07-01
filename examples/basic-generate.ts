/**
 * Basic generateText example using ai-sdk-provider-pi.
 *
 * Usage: npx tsx examples/basic-generate.ts
 */

import { pi } from '../src/index.js';
import { generateText } from 'ai';

async function main() {
  const model = pi('sonnet');

  try {
    const { text, usage, finishReason, warnings } = await generateText({
      model,
      prompt: '用一句话解释什么是量子计算。',
    });

    console.log('=== Response ===');
    console.log(text);
    console.log();

    console.log('=== Usage ===');
    console.log(`Input tokens:  ${usage.inputTokens ?? 'N/A'}`);
    console.log(`Output tokens: ${usage.outputTokens ?? 'N/A'}`);

    console.log();
    console.log('=== Finish Reason ===');
    console.log(JSON.stringify(finishReason, null, 2));

    if (warnings != null && warnings.length > 0) {
      console.log();
      console.log('=== Warnings ===');
      for (const w of warnings) console.log(`  - ${w.type}: ${'message' in w ? w.message : w.details ?? 'no details'}`);
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    (model as any).dispose();
  }
}

main();
