import { describe, it, expect } from 'vitest';
import { convertToPiMessages, buildPromptFromContext } from '../src/convert-to-pi-messages.js';
import type { ModelMessage } from 'ai';

describe('convertToPiMessages', () => {
  // ── System messages ──

  it('extracts system prompt from system message', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.systemPrompt).toBe('You are a helpful assistant.');
    expect(warnings).toEqual([]);
  });

  // ── User messages ──

  it('converts simple string user message', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Hello!' },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].role).toBe('user');
    expect(warnings).toEqual([]);
  });

  it('converts user message with text parts', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello from parts!' }],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('converts user message with image data URL', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' },
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('warns about image URLs (not supported)', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Check this image' },
          { type: 'image', image: new URL('https://example.com/image.png') },
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('Image URLs are not supported');
  });

  // ── Assistant messages ──

  it('converts simple string assistant message', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello! How can I help?' },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(2);
    const assistantMsg = context.messages[1];
    expect(assistantMsg.role).toBe('assistant');
    expect(warnings).toEqual([]);
  });

  it('converts assistant message with tool calls', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Read file' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read that file.' },
          {
            type: 'tool-call',
            toolCallId: 'call_123',
            toolName: 'read',
            input: '{"path": "/tmp/test.txt"}',
          },
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  it('skips empty assistant messages', () => {
    const messages: ModelMessage[] = [
      { role: 'assistant', content: '' },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(0);
  });

  // ── Tool messages ──

  it('converts tool result messages', () => {
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_123',
            toolName: 'read',
            output: { type: 'text', value: 'File content here' },
          },
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].role).toBe('toolResult');
    expect(warnings).toEqual([]);
  });

  it('converts tool result with error output', () => {
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_456',
            toolName: 'bash',
            output: { type: 'error-text', value: 'Command failed' },
          },
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    const toolMsg = context.messages[0] as any;
    expect(toolMsg.isError).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('converts tool result with json output', () => {
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_789',
            toolName: 'search',
            output: { type: 'json', value: { results: ['a', 'b'] } },
          },
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('converts tool result with execution-denied output', () => {
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_denied',
            toolName: 'bash',
            output: { type: 'execution-denied' },
          },
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    const toolMsg = context.messages[0] as any;
    expect(toolMsg.isError).toBe(false);
    expect(warnings).toEqual([]);
  });

  // ── Multi-turn conversation ──

  it('converts a full multi-turn conversation', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.systemPrompt).toBe('You are helpful.');
    expect(context.messages).toHaveLength(3);
    expect(warnings).toEqual([]);
  });

  // ── Reasoning ──

  it('converts assistant message with reasoning', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Let me think about this...' },
          { type: 'text', text: 'Here is my answer.' },
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    const assistantMsg = context.messages[1] ?? context.messages[0];
    expect(assistantMsg.role).toBe('assistant');
    expect(warnings).toEqual([]);
  });
});

describe('buildPromptFromContext', () => {
  it('returns the last user message text', () => {
    const { context } = convertToPiMessages([
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: 'Response' },
      { role: 'user', content: 'Second message' },
    ]);
    expect(buildPromptFromContext(context)).toBe('Second message');
  });

  it('returns empty string when there are no user messages', () => {
    const { context } = convertToPiMessages([
      { role: 'assistant', content: 'Hello' },
    ]);
    expect(buildPromptFromContext(context)).toBe('');
  });

  it('returns empty string for empty messages', () => {
    const { context } = convertToPiMessages([]);
    expect(buildPromptFromContext(context)).toBe('');
  });

  it('handles user message with content parts', () => {
    const { context } = convertToPiMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'text', text: 'Line 2' },
        ],
      },
    ]);
    const prompt = buildPromptFromContext(context);
    expect(prompt).toContain('Line 1');
    expect(prompt).toContain('Line 2');
  });
});
