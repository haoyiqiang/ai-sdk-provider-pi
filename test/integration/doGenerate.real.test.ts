import { describe, it, expect } from 'vitest';
import { pi } from '../../src/index.js';

const runIntegration = process.env.PI_INTEGRATION_TEST === 'true';
const test = runIntegration ? it : it.skip;

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
}

describe.runIf(runIntegration)('Real doGenerate', () => {
  test('sends prompt and returns content', async () => {
    const model = pi('deepseek-v4-flash');
    try {
      const { content, finishReason } = await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Say hello in one word' }] }],
      });
      const text = extractText(content);
      expect(text).toBeTruthy();
      expect(text.length).toBeGreaterThan(0);
      expect(finishReason.unified).toBe('stop');
    } finally {
      (model as any).dispose();
    }
  });

  test('passes system prompt', async () => {
    const model = pi('deepseek-v4-flash');
    try {
      const { content } = await model.doGenerate({
        prompt: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: [{ type: 'text', text: 'Say hello' }] },
        ],
      });
      const text = extractText(content);
      expect(text).toBeTruthy();
      expect(text.length).toBeGreaterThan(0);
    } finally {
      (model as any).dispose();
    }
  });

  test('handles multi-turn messages', async () => {
    const model = pi('deepseek-v4-flash');
    try {
      const { content } = await model.doGenerate({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'My name is Alice' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Nice to meet you, Alice!' }] },
          { role: 'user', content: [{ type: 'text', text: 'What is my name?' }] },
        ],
      });
      const text = extractText(content);
      expect(text).toBeTruthy();
      expect(text.length).toBeGreaterThan(0);
    } finally {
      (model as any).dispose();
    }
  });
});
