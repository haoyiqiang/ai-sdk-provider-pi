import { describe, it, expect } from 'vitest';
import { NoSuchModelError, APICallError, LoadAPIKeyError } from '@ai-sdk/provider';
import { pi, isAuthenticationError, isTimeoutError, handlePiError } from '../../src/index.js';

const runIntegration = process.env.PI_INTEGRATION_TEST === 'true';
const test = runIntegration ? it : it.skip;

describe.runIf(runIntegration)('Real error scenarios', () => {
  test('invalid model ID throws NoSuchModelError', () => {
    expect(() => pi('nonexistent/unknown-model-12345')).toThrow(NoSuchModelError);
  });

  test('empty model ID throws', () => {
    expect(() => pi('')).toThrow();
  });

  test('authentication error is detected', async () => {
    const model = pi('deepseek-v4-flash');
    try {
      // Temporarily clear api key via env mock (test sets an invalid key)
      // This tests that handlePiError correctly maps auth errors
      const originalKey = process.env.DEEPSEEK_API_KEY;
      process.env.DEEPSEEK_API_KEY = 'sk-invalid-key-for-test';
      try {
        await model.doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(isAuthenticationError(error)).toBe(true);
      } finally {
        process.env.DEEPSEEK_API_KEY = originalKey;
      }
    } finally {
      (model as any).dispose();
    }
  });

  test('abort signal works without real API call', async () => {
    const model = pi('deepseek-v4-flash');
    const abortController = new AbortController();
    abortController.abort(); // pre-abort
    try {
      await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        abortSignal: abortController.signal,
      });
      expect.unreachable('should have thrown due to pre-abort');
    } catch {
      // expected
    } finally {
      (model as any).dispose();
    }
  });
});
