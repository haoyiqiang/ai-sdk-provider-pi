import { describe, it, expect } from 'vitest';
import { pi } from '../../src/index.js';

const runIntegration = process.env.PI_INTEGRATION_TEST === 'true';
const test = runIntegration ? it : it.skip;

describe.runIf(runIntegration)('Real doGenerate', () => {
  test('sends prompt and returns text', async () => {
    const model = pi('deepseek-v4-flash');
    try {
      const { text, finishReason } = await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      });
      expect(text).toBeTruthy();
      expect(text).toContain('Hello');
      expect(finishReason.unified).toBe('stop');
    } finally {
      (model as any).dispose();
    }
  });

  test('passes system prompt', async () => {
    const model = pi('deepseek-v4-flash');
    try {
      const { text } = await model.doGenerate({
        prompt: [
          { role: 'system', content: 'You are a helpful assistant. Always answer in English.' },
          { role: 'user', content: [{ type: 'text', text: 'Say hello' }] },
        ],
      });
      expect(text).toBeTruthy();
      expect(text.toLowerCase()).toContain('hello');
    } finally {
      (model as any).dispose();
    }
  });

  test('handles multi-turn messages', async () => {
    const model = pi('deepseek-v4-flash');
    try {
      const { text } = await model.doGenerate({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'My name is Alice' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Nice to meet you, Alice!' }] },
          { role: 'user', content: [{ type: 'text', text: 'What is my name?' }] },
        ],
      });
      expect(text).toBeTruthy();
      expect(text).toContain('Alice');
    } finally {
      (model as any).dispose();
    }
  });
});
