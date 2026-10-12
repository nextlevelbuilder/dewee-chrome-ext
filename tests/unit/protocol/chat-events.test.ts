import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal, mapRuntimeFrame } from '../../../src/protocol/chat-events';

const card = JSON.parse(
  readFileSync(join(__dirname, '../../contract-fixtures/ui-action-v1/examples/secret_request.json'), 'utf8'),
);

describe('mapRuntimeFrame', () => {
  it('maps chat.started run metadata', () => {
    expect(
      mapRuntimeFrame({ event: 'chat.started', data: '{"run_id":"r1","session_key":"agent:super-agent:s1","agent_key":"super-agent"}' }),
    ).toEqual({ type: 'chat.started', runId: 'r1', sessionKey: 'agent:super-agent:s1', agentKey: 'super-agent' });
  });

  it('maps deltas and drops unknown events or malformed JSON', () => {
    expect(mapRuntimeFrame({ event: 'message.delta', data: '{"delta":"Hi"}' })).toEqual({ type: 'message.delta', delta: 'Hi' });
    expect(mapRuntimeFrame({ event: 'block.reply', data: '{}' })).toBeNull();
    expect(mapRuntimeFrame({ event: 'message.delta', data: '{not json' })).toBeNull();
    expect(mapRuntimeFrame({ event: 'message.delta', data: '[1]' })).toBeNull();
  });

  it('attaches a valid ui_action card to a completed tool call', () => {
    const event = mapRuntimeFrame({
      event: 'tool.call.completed',
      data: JSON.stringify({ tool_call: { id: 't1', name: 'ui_action', result_summary: 'ok' }, ui_action: card }),
    });
    expect(event?.type).toBe('tool.call.completed');
    expect(event && 'toolCall' in event && event.toolCall.uiAction?.kind).toBe('secret_request');
  });

  it('drops an invalid ui_action card but keeps the tool call', () => {
    const event = mapRuntimeFrame({
      event: 'tool.call.completed',
      data: JSON.stringify({ tool_call: { id: 't1', name: 'ui_action' }, ui_action: { ...card, kind: 'html' } }),
    });
    expect(event && 'toolCall' in event && event.toolCall.uiAction).toBeUndefined();
    expect(event && 'toolCall' in event && event.toolCall.id).toBe('t1');
  });

  it('normalizes chat.error recovery and rejects mismatched pairs', () => {
    expect(mapRuntimeFrame({ event: 'chat.error', data: '{"code":"context_limit","recovery_action":"start_new_chat"}' })).toEqual({
      type: 'chat.error',
      code: 'context_limit',
      action: 'start_new_chat',
    });
    expect(mapRuntimeFrame({ event: 'chat.error', data: '{"code":"context_limit","recovery_action":"retry"}' })).toEqual({
      type: 'chat.error',
      code: 'runtime_request_failed',
      action: 'retry',
    });
  });

  it('maps message.completed and flags terminal events', () => {
    const done = mapRuntimeFrame({
      event: 'message.completed',
      data: '{"message":{"role":"assistant","content":"Done","created_at":"2026-10-11T10:00:00Z"},"media":[{"path":"/v1/files/a?ft=x","content_type":"image/png"}]}',
    })!;
    expect(done).toMatchObject({ type: 'message.completed', content: 'Done', media: [{ path: '/v1/files/a?ft=x', contentType: 'image/png' }] });
    expect(isTerminal(done)).toBe(true);
    expect(isTerminal({ type: 'message.delta', delta: '' })).toBe(false);
  });
});
