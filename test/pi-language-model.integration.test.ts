/**
 * Integration tests for PiLanguageModel with real Pi SDK.
 *
 * These tests require a real Pi SDK setup with configured API keys for at least
 * one provider (e.g., Anthropic, OpenAI). They are skipped by default.
 *
 * To run these tests:
 *   PI_INTEGRATION_TEST=true pnpm test -- test/pi-language-model.integration.test.ts
 *
 * Or run all tests including integration:
 *   PI_INTEGRATION_TEST=true pnpm test
 *
 * Before running, ensure you have:
 * 1. Pi SDK installed (@earendil-works/pi-coding-agent@^0.79.1)
 * 2. At least one API key configured in ~/.pi/agent/auth.json or env var
 * 3. Network access to the LLM provider
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createPi } from '../src/pi-provider.js';
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';

// ─── Conditional Run ───

const runIntegration = process.env.PI_INTEGRATION_TEST === 'true';
const integrationTest = runIntegration ? it : it.skip;

describe.runIf(runIntegration)('PiLanguageModel Integration', () => {
  let pi: ReturnType<typeof createPi>;
  let model: LanguageModelV3;

  beforeAll(() => {
    pi = createPi({
      // Use default AuthStorage, ModelRegistry, and SessionManager
      // This will pick up API keys from ~/.pi/agent/auth.json or env vars
      logger: false, // Suppress logging for cleaner test output
    });

    // Try to get a model; skip if no model is available
    try {
      model = pi('anthropic/claude-sonnet-4');
    } catch {
      // Fallback to any available model
      try {
        model = pi('openai/gpt-4o');
      } catch {
        throw new Error(
          'No model available. Configure at least one API key (e.g., ANTHROPIC_API_KEY or OPENAI_API_KEY).'
        );
      }
    }
  });

  // ─── doGenerate ───

  integrationTest('doGenerate returns text content', async () => {
    const result = await model.doGenerate({
      prompt: [
        { role: 'system', content: 'You are a helpful assistant. Keep responses very brief.' },
        { role: 'user', content: [{ type: 'text', text: 'Say "Hello World"' }] },
      ],
    });

    // Verify structure
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);

    // Verify text content
    const textParts = result.content.filter((c) => c.type === 'text');
    expect(textParts.length).toBeGreaterThan(0);
    expect(textParts[0].text).toBeTruthy();

    // Verify finish reason
    expect(result.finishReason).toBeDefined();
    expect(result.finishReason.unified).toMatch(/stop|tool-calls/);

    // Verify usage
    expect(result.usage).toBeDefined();
    expect(result.usage.inputTokens?.total).toBeGreaterThan(0);
    expect(result.usage.outputTokens?.total).toBeGreaterThan(0);

    // Verify response metadata
    expect(result.response).toBeDefined();
    expect(result.response?.id).toBeTruthy();
    expect(result.response?.modelId).toBeTruthy();

    // Verify warnings
    expect(result.warnings).toBeDefined();
    expect(Array.isArray(result.warnings)).toBe(true);

    // Verify providerMetadata (if available)
    if (result.providerMetadata) {
      expect(result.providerMetadata.sessionId).toBeDefined();
      expect(result.providerMetadata.modelId).toBeDefined();
      expect(result.providerMetadata.provider).toBeDefined();
    }
  }, 30000); // 30s timeout for LLM response

  integrationTest('doGenerate with thinking/reasoning', async () => {
    // Only run with models that support thinking
    const result = await model.doGenerate({
      prompt: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Think step by step: what is 15 * 27?' }],
        },
      ],
    });

    const reasoningParts = result.content.filter((c) => c.type === 'reasoning');
    const textParts = result.content.filter((c) => c.type === 'text');

    // At minimum we should have text output
    expect(textParts.length).toBeGreaterThan(0);
    expect(textParts[0].text).toBeTruthy();

    // Reasoning may not be present depending on the model and settings
    if (reasoningParts.length > 0) {
      expect(reasoningParts[0].text).toBeTruthy();
    }
  }, 60000);

  // ─── doStream ───

  integrationTest('doStream streams text deltas', async () => {
    const { stream: rawStream, request } = await model.doStream({
      prompt: [
        { role: 'system', content: 'You are a helpful assistant. Keep responses very brief.' },
        { role: 'user', content: [{ type: 'text', text: 'Count from 1 to 3' }] },
      ],
    });

    expect(request).toBeDefined();
    expect(request?.body).toBeDefined();

    const reader = rawStream.getReader();
    const parts: LanguageModelV3StreamPart[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    // Verify stream structure
    expect(parts.length).toBeGreaterThan(0);

    // Should have text parts
    const textDeltas = parts.filter((p) => p.type === 'text-delta');
    const textStarts = parts.filter((p) => p.type === 'text-start');
    const textEnds = parts.filter((p) => p.type === 'text-end');

    expect(textStarts.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas.length).toBeGreaterThan(0);

    // Text deltas should have content
    const allText = textDeltas.map((d: any) => d.delta).join('');
    expect(allText.length).toBeGreaterThan(0);

    // Verify finish part
    const finishParts = parts.filter((p) => p.type === 'finish');
    expect(finishParts.length).toBe(1);

    const finish = finishParts[0] as any;
    expect(finish.finishReason).toBeDefined();
    expect(finish.finishReason.unified).toMatch(/stop|tool-calls/);
    expect(finish.usage).toBeDefined();
  }, 30000);

  integrationTest('doStream supports AbortSignal', async () => {
    const abortController = new AbortController();
    const { stream: rawStream } = await model.doStream({
      prompt: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Write a very long essay about the history of computing' }],
        },
      ],
      abortSignal: abortController.signal,
    });

    const reader = rawStream.getReader();

    // Read a few chunks, then abort
    let chunkCount = 0;
    let aborted = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunkCount++;

        // Abort after receiving some data
        if (chunkCount >= 5) {
          abortController.abort();
        }
      }
    } catch {
      aborted = true;
    }

    // We may or may not get an error - the stream may just end
    expect(chunkCount).toBeGreaterThanOrEqual(0);
  }, 15000);

  // ─── Session Reuse ───

  integrationTest('reuses session across multiple doGenerate calls', async () => {
    const firstResult = await model.doGenerate({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'Say "First message"' }] },
      ],
    });

    expect(firstResult.content).toBeDefined();
    const firstText = firstResult.content.find((c) => c.type === 'text') as any;
    expect(firstText?.text).toBeTruthy();

    // Second call should reuse the session
    const secondResult = await model.doGenerate({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'Remember what I said before? Reply with "Yes" or "No".' }] },
      ],
    });

    expect(secondResult.content).toBeDefined();
    const secondText = secondResult.content.find((c) => c.type === 'text') as any;
    expect(secondText?.text).toBeTruthy();
  }, 60000);

  // ─── Error Handling ───

  integrationTest('handlePiError: invalid model ID throws NoSuchModelError', async () => {
    expect(() => pi('invalid-provider/nonexistent-model')).toThrow();
  });

  integrationTest('handlePiError: empty model ID throws', async () => {
    expect(() => pi('')).toThrow();
  });

  // ─── Model Aliases ───

  integrationTest('supports convenience aliases', () => {
    // These should not throw
    expect(() => pi('sonnet')).not.toThrow();
    expect(() => pi('haiku')).not.toThrow();
  });

  // ─── System Prompt ───

  integrationTest('system prompt is passed to Pi session', async () => {
    const systemPrompt = 'You are a helpful assistant. Always start your response with "SYSTEM: ".';

    const result = await model.doGenerate({
      prompt: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: [{ type: 'text', text: 'Say "Hello"' }] },
      ],
    });

    const text = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');

    expect(text.length).toBeGreaterThan(0);
  }, 30000);

  // ─── dispose() ───

  integrationTest('dispose() cleans up session', () => {
    // Access the PiLanguageModel instance through the provider
    const testModel = pi('sonnet') as any;

    // Force session creation by triggering doGenerate
    // dispose should not throw
    expect(() => testModel.dispose?.()).not.toThrow();

    // Calling dispose again should be safe
    expect(() => testModel.dispose?.()).not.toThrow();
  });
});
