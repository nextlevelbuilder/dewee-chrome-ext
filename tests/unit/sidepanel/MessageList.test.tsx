import { fireEvent, render, screen } from '@testing-library/react';
import { initialChatState, type ChatMessage, type ChatState } from '../../../src/chat/chat-state';
import type { RespondFn } from '../../../src/credentials/respond-types';
import { MessageList } from '../../../src/sidepanel/components/MessageList';

const respond = vi.fn<RespondFn>();

const failed = (patch: Partial<ChatMessage>): ChatState => ({
  ...initialChatState('s1'),
  phase: 'idle',
  messages: [
    { id: 'u1', role: 'user', content: 'Hello' },
    { id: 'u1-reply', role: 'assistant', content: '', error: { code: 'network_error' }, ...patch },
  ],
});

function renderList(state: ChatState, handlers: { onRetry?: () => void; onReload?: () => void } = {}) {
  const props = { agentName: 'Super Agent', respond, onLoadOlder: vi.fn(), onShowSessions: vi.fn(), onRetry: handlers.onRetry ?? vi.fn(), onReload: handlers.onReload ?? vi.fn() };
  const view = render(<MessageList state={state} {...props} />);
  return { ...view, rerenderWith: (next: ChatState) => view.rerender(<MessageList state={next} {...props} />) };
}

describe('MessageList recovery focus', () => {
  beforeAll(() => {
    // jsdom has no layout, so it does not implement scrolling.
    Element.prototype.scrollIntoView ??= () => {};
  });

  it.each([
    ['Send again', { retryText: 'Hello' }],
    ['Continue', { retryContinuation: { session_key: 's1', agent_key: 'a', setup_action_id: 'act_1' } }],
    ['Reload conversation', { recover: 'reload' as const, error: { code: 'delivery_unconfirmed' } }],
  ])('moves focus to the conversation when "%s" removes its own button', (label, patch) => {
    const onRetry = vi.fn();
    const onReload = vi.fn();
    const { rerenderWith } = renderList(failed(patch), { onRetry, onReload });
    const button = screen.getByRole('button', { name: label });
    button.focus();

    fireEvent.click(button);
    rerenderWith({ ...initialChatState('s1'), phase: 'reconciling', messages: [{ id: 'u1', role: 'user', content: 'Hello' }] });

    expect(screen.queryByRole('button', { name: label })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('log'));
    expect(onRetry.mock.calls.length + onReload.mock.calls.length).toBe(1);
  });

  it('labels an unconfirmed message with the new wording and offers no "Send again"', () => {
    renderList(failed({ recover: 'reload', error: { code: 'delivery_unconfirmed' } }));
    expect(screen.getByRole('alert').textContent).toContain('Delivery could not be confirmed');
    expect(screen.queryByRole('button', { name: 'Send again' })).toBeNull();
  });
});

describe('MessageList optional details', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView ??= () => {};
  });

  const reply: ChatState = {
    ...initialChatState('s1'),
    phase: 'idle',
    messages: [
      { id: 'u1', role: 'user', content: 'Connect a provider' },
      {
        id: 'u1-reply',
        role: 'assistant',
        content: 'Done',
        thinking: 'The user wants <b>a provider</b>.',
        tools: [{ id: 't1', name: 'exec', state: 'error', input: '{\n  "command": "dewee providers list"\n}', error: '<img src=x onerror=alert(1)>' }],
      },
    ],
  };
  const props = { agentName: 'Super Agent', respond, onLoadOlder: vi.fn(), onShowSessions: vi.fn(), onRetry: vi.fn(), onReload: vi.fn() };

  it('shows only the tool chip and no reasoning while both options are off', () => {
    const { container } = render(<MessageList state={reply} {...props} />);
    expect(screen.getByText('exec failed')).toBeTruthy();
    expect(container.querySelector('details')).toBeNull();
    expect(container.textContent).not.toContain('dewee providers list');
    expect(container.textContent).not.toContain('a provider</b>');
  });

  it('shows reasoning and tool input and error as plain text when turned on', () => {
    const { container } = render(<MessageList state={reply} {...props} display={{ reasoning: true, toolDetails: true }} />);
    const reasoning = container.querySelector('details.reasoning');
    expect(reasoning?.querySelector('summary')?.textContent).toBe('Reasoning');
    expect(reasoning?.querySelector('pre')?.textContent).toBe('The user wants <b>a provider</b>.');

    const tool = container.querySelector('details.tool-detail');
    expect(tool?.querySelector('summary')?.textContent).toContain('exec failed');
    expect(tool?.textContent).toContain('"command": "dewee providers list"');
    expect(tool?.querySelector('.detail-error')?.textContent).toBe('<img src=x onerror=alert(1)>');
    // Rendered as text, never as markup.
    expect(container.querySelector('img:not(.brand-mark), b')).toBeNull();
  });

  it('keeps a tool without detail text as a plain chip even when details are on', () => {
    const plain: ChatState = { ...reply, messages: [{ id: 'r', role: 'assistant', content: 'ok', tools: [{ id: 't', name: 'search', state: 'done' }] }] };
    const { container } = render(<MessageList state={plain} {...props} display={{ reasoning: true, toolDetails: true }} />);
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getByText('Used search')).toBeTruthy();
  });
});