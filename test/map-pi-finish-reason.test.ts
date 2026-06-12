import { describe, it, expect } from 'vitest';
import { mapPiFinishReason } from '../src/map-pi-finish-reason.js';

describe('mapPiFinishReason', () => {
  // ── Pi native StopReason values ──

  it('maps "stop" to unified "stop"', () => {
    const result = mapPiFinishReason('stop');
    expect(result).toEqual({ unified: 'stop', raw: 'stop' });
  });

  it('maps "length" to unified "length"', () => {
    const result = mapPiFinishReason('length');
    expect(result).toEqual({ unified: 'length', raw: 'length' });
  });

  it('maps "toolUse" to unified "tool-calls"', () => {
    const result = mapPiFinishReason('toolUse');
    expect(result).toEqual({ unified: 'tool-calls', raw: 'toolUse' });
  });

  it('maps "error" to unified "error"', () => {
    const result = mapPiFinishReason('error');
    expect(result).toEqual({ unified: 'error', raw: 'error' });
  });

  it('maps "aborted" to unified "error"', () => {
    const result = mapPiFinishReason('aborted');
    expect(result).toEqual({ unified: 'error', raw: 'aborted' });
  });

  // ── Anthropic-style stop reasons ──

  it('maps "end_turn" to unified "stop"', () => {
    const result = mapPiFinishReason('end_turn');
    expect(result).toEqual({ unified: 'stop', raw: 'end_turn' });
  });

  it('maps "max_tokens" to unified "length"', () => {
    const result = mapPiFinishReason('max_tokens');
    expect(result).toEqual({ unified: 'length', raw: 'max_tokens' });
  });

  it('maps "stop_sequence" to unified "stop"', () => {
    const result = mapPiFinishReason('stop_sequence');
    expect(result).toEqual({ unified: 'stop', raw: 'stop_sequence' });
  });

  it('maps "tool_use" to unified "tool-calls"', () => {
    const result = mapPiFinishReason('tool_use');
    expect(result).toEqual({ unified: 'tool-calls', raw: 'tool_use' });
  });

  // ── OpenAI-style stop reasons ──

  it('maps "tool_calls" to unified "tool-calls"', () => {
    const result = mapPiFinishReason('tool_calls');
    expect(result).toEqual({ unified: 'tool-calls', raw: 'tool_calls' });
  });

  it('maps "content_filter" to unified "content-filter"', () => {
    const result = mapPiFinishReason('content_filter');
    expect(result).toEqual({ unified: 'content-filter', raw: 'content_filter' });
  });

  // ── Google-style stop reasons ──

  it('maps "STOP" to unified "stop"', () => {
    const result = mapPiFinishReason('STOP');
    expect(result).toEqual({ unified: 'stop', raw: 'STOP' });
  });

  it('maps "MAX_TOKENS" to unified "length"', () => {
    const result = mapPiFinishReason('MAX_TOKENS');
    expect(result).toEqual({ unified: 'length', raw: 'MAX_TOKENS' });
  });

  it('maps "SAFETY" to unified "content-filter"', () => {
    const result = mapPiFinishReason('SAFETY');
    expect(result).toEqual({ unified: 'content-filter', raw: 'SAFETY' });
  });

  it('maps "RECITATION" to unified "content-filter"', () => {
    const result = mapPiFinishReason('RECITATION');
    expect(result).toEqual({ unified: 'content-filter', raw: 'RECITATION' });
  });

  it('maps "MALFORMED_FUNCTION_CALL" to unified "error"', () => {
    const result = mapPiFinishReason('MALFORMED_FUNCTION_CALL');
    expect(result).toEqual({ unified: 'error', raw: 'MALFORMED_FUNCTION_CALL' });
  });

  // ── Mistral-style stop reasons ──

  it('maps "tool_call" to unified "tool-calls"', () => {
    const result = mapPiFinishReason('tool_call');
    expect(result).toEqual({ unified: 'tool-calls', raw: 'tool_call' });
  });

  // ── Null / undefined / unknown ──

  it('maps undefined to unified "stop" with raw undefined', () => {
    const result = mapPiFinishReason(undefined);
    expect(result).toEqual({ unified: 'stop', raw: undefined });
  });

  it('maps null to unified "stop" with raw undefined', () => {
    const result = mapPiFinishReason(null as any);
    expect(result).toEqual({ unified: 'stop', raw: undefined });
  });

  it('maps unknown string to unified "other"', () => {
    const result = mapPiFinishReason('some_unknown_reason');
    expect(result).toEqual({ unified: 'other', raw: 'some_unknown_reason' });
  });

  // ── Always preserves raw value ──

  it('always preserves the original value in raw', () => {
    const result = mapPiFinishReason('end_turn');
    expect(result.raw).toBe('end_turn');
  });
});
