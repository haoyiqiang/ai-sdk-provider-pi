/**
 * Basic streamText example using ai-sdk-provider-pi.
 *
 * Usage: npx tsx examples/basic-stream.ts
 */

import { pi } from '../src/index.js';
import { streamText } from 'ai';

async function main() {
  const model = pi('sonnet');

  try {
    const result = streamText({
      model,
      prompt: '写一首关于编程的简短俳句。',
    });

    console.log('=== Streaming Response ===');

    // Stream text deltas
    for await (const chunk of result.textStream) {
      process.stdout.write(chunk);
    }
    console.log('\n');

    // Get final metadata
    const usage = await result.usage;
    const finishReason = await result.finishReason;
    console.log('=== Usage ===');
    console.log(`Input tokens:  ${usage.inputTokens ?? 'N/A'}`);
    console.log(`Output tokens: ${usage.outputTokens ?? 'N/A'}`);
    console.log();

    console.log('=== Finish Reason ===');
    console.log(JSON.stringify(finishReason, null, 2));
  } catch (error) {
    console.error('Error:', error);
  } finally {
    (model as any).dispose();
  }
}

main();
