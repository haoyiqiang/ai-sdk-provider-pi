/**
 * Basic streamText example using ai-sdk-provider-pi.
 *
 * Usage: cp .env.example .env  # 配置 PI_MODEL_ID 和 API key
 *        npx tsx examples/basic-stream.ts
 */
import 'dotenv/config';
import { pi } from '../src/index.js';
import { streamText } from 'ai';

const MODEL_ID = process.env.PI_MODEL_ID ?? 'deepseek-v4-flash';

async function main() {
  const model = pi(MODEL_ID);

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
