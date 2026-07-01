/**
 * Error handling example using ai-sdk-provider-pi.
 *
 * Usage: npx tsx examples/error-handling.ts
 */

import {
  pi,
  isAuthenticationError,
  isTimeoutError,
  isContextOverflowError,
  getErrorMetadata,
} from '../src/index.js';
import { generateText } from 'ai';
import { APICallError, LoadAPIKeyError } from '@ai-sdk/provider';

async function main() {
  console.log('=== Error Handling Examples ===\n');

  // Example 1: Invalid model ID
  console.log('1. Invalid model ID:');
  try {
    const model = pi('invalid-provider/nonexistent-model');
    await generateText({ model, prompt: 'Hello' });
  } catch (error) {
    console.log(`   Caught: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }

  // Example 2: Empty model ID
  console.log('\n2. Empty model ID:');
  try {
    pi('');
  } catch (error) {
    console.log(`   Caught: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }

  // Example 3: Using error type guards
  console.log('\n3. Error type guards demo:');
  const fakeAuthError = new LoadAPIKeyError({ message: 'API key not found' });
  const fakeTimeoutError = new APICallError({
    message: 'Timeout',
    url: 'pi://test',
    requestBodyValues: {},
    isRetryable: true,
    data: { code: 'TIMEOUT' },
  });
  const fakeContextError = new APICallError({
    message: 'Context overflow',
    url: 'pi://test',
    requestBodyValues: {},
    isRetryable: false,
    data: { code: 'CONTEXT_OVERFLOW' },
  });

  console.log(`   isAuthenticationError(fakeAuthError): ${isAuthenticationError(fakeAuthError)}`);
  console.log(`   isTimeoutError(fakeTimeoutError): ${isTimeoutError(fakeTimeoutError)}`);
  console.log(`   isContextOverflowError(fakeContextError): ${isContextOverflowError(fakeContextError)}`);

  // Example 4: Extract error metadata
  console.log('\n4. Error metadata extraction:');
  const errorWithMeta = new APICallError({
    message: 'Something failed',
    url: 'pi://anthropic/claude-sonnet-4',
    requestBodyValues: {},
    isRetryable: false,
    data: {
      code: 'CUSTOM_ERROR',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4',
      sessionId: 'sess_abc123',
    },
  });
  const meta = getErrorMetadata(errorWithMeta);
  console.log(`   code: ${meta?.code}`);
  console.log(`   provider: ${meta?.provider}`);
  console.log(`   modelId: ${meta?.modelId}`);
  console.log(`   sessionId: ${meta?.sessionId}`);
}

main();
