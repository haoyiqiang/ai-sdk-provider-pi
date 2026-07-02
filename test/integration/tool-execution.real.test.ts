import { describe, it, expect } from 'vitest';
import { createPi } from '../../src/index.js';

const runIntegration = process.env.PI_INTEGRATION_TEST === 'true';
const test = runIntegration ? it : it.skip;

describe.runIf(runIntegration)('Real tool execution', () => {
  test('executes a tool call (read package.json)', async () => {
    const pi = createPi({ cwd: process.cwd() });
    const model = pi('deepseek-v4-flash');
    try {
      // Ask Pi to use a tool
      const { text } = await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Use read tool to read package.json in current directory. What is the project name?' }] }],
      });
      expect(text).toBeTruthy();
      expect(text.toLowerCase()).toContain('ai-sdk-provider-pi');
    } finally {
      (model as any).dispose();
    }
  });

  test('works with noTools option', async () => {
    const pi = createPi({ noTools: 'all' });
    const model = pi('deepseek-v4-flash');
    try {
      const { text } = await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Say hello world' }] }],
      });
      expect(text).toBeTruthy();
    } finally {
      (model as any).dispose();
    }
  });

  test('tool call appears in stream', async () => {
    const pi = createPi({ cwd: process.cwd() });
    const model = pi('deepseek-v4-flash');
    try {
      const stream = await model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Use read tool to read package.json' }] }],
      });
      let hasToolCallToolStart = false;
      let hasToolCallToolEnd = false;
      const reader = stream.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === 'tool-call-start') hasToolCallToolStart = true;
        if (value.type === 'tool-call-end') hasToolCallToolEnd = true;
      }
      expect(hasToolCallToolStart).toBe(true);
      expect(hasToolCallToolEnd).toBe(true);
    } finally {
      (model as any).dispose();
    }
  });
});
