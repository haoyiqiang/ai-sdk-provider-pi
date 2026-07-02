import { describe, it, expect } from 'vitest';
import { pi } from '../../src/index.js';

const runIntegration = process.env.PI_INTEGRATION_TEST === 'true';
const test = runIntegration ? it : it.skip;

describe.runIf(runIntegration)('Real doStream', () => {
  test('streams text deltas', async () => {
    const model = pi('deepseek-v4-flash');
    try {
      const stream = await model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Count 1 to 3' }] }],
      });
      const parts: string[] = [];
      const reader = stream.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === 'text-delta' && 'textDelta' in value) {
          parts.push((value as any).textDelta);
        }
      }
      expect(parts.length).toBeGreaterThan(0);
      const full = parts.join('');
      expect(full).toContain('1');
    } finally {
      (model as any).dispose();
    }
  });

  test('stream includes finish event', async () => {
    const model = pi('deepseek-v4-flash');
    try {
      const stream = await model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Say hi' }] }],
      });
      let hasFinish = false;
      const reader = stream.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === 'finish') hasFinish = true;
      }
      expect(hasFinish).toBe(true);
    } finally {
      (model as any).dispose();
    }
  });

  test('abort stops streaming', async () => {
    const model = pi('deepseek-v4-flash');
    const abortController = new AbortController();
    try {
      const prompt = 'Write a very long essay about AI. '.repeat(100);
      const streamPromise = model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        abortSignal: abortController.signal,
      });
      // Let it start then abort
      setTimeout(() => abortController.abort(), 200);
      await expect(streamPromise).rejects.toThrow();
    } finally {
      (model as any).dispose();
    }
  });
});
