import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { DeweeClient } from '../../../src/api/dewee-client';
import { DeweeApiError } from '../../../src/api/errors';
import { loadPendingContinuations } from '../../../src/chat/pending-continuations';
import type { RespondFn } from '../../../src/credentials/respond-types';
import type { UiActionCard } from '../../../src/protocol/ui-action';
import { ChatShell } from '../../../src/sidepanel/ChatShell';
import { defaultSettings, type Profile, type Settings } from '../../../src/shared/settings';

const captured: { respond?: RespondFn } = {};
let respondResult: (value: unknown) => void = () => {};
let respondFail: (error: unknown) => void = () => {};

const fake = {
  workspaces: vi.fn(async () => [
    { id: 'ws_1', name: 'One', status: 'active' },
    { id: 'ws_2', name: 'Two', status: 'active' },
  ]),
  agents: vi.fn(async () => ({
    agents: [
      { key: 'super-agent', name: 'Super Agent', status: 'active', is_super: true },
      { key: 'helper', name: 'Helper', status: 'active', is_super: false },
    ],
  })),
  sessions: vi.fn(async (): Promise<{ sessions: unknown[]; total?: number }> => ({ sessions: [] })),
  history: vi.fn(async () => ({ messages: [], reset: false })),
  status: vi.fn(async () => ({ running: false })),
  actions: vi.fn(async (): Promise<unknown[]> => []),
  respond: vi.fn(
    () =>
      new Promise((resolve, reject) => {
        respondResult = resolve;
        respondFail = reject;
      }),
  ),
};

vi.mock('../../../src/api/client-factory', () => ({
  createClient: () => fake as unknown as DeweeClient,
  pageAuthAdapter: () => ({}),
}));
vi.mock('../../../src/protocol/messages', () => ({ callBackground: vi.fn(async () => ({ ok: true })) }));
vi.mock('../../../src/sidepanel/components/MessageList', () => ({
  MessageList: (props: { respond: RespondFn }) => {
    captured.respond = props.respond;
    return null;
  },
}));

const profile: Profile = { id: 'p_1', name: 'Gateway', kind: 'gateway', origin: 'https://gw.example.com', remember: false };

function Shell({ workspaces = {} }: { workspaces?: Settings['selections'][string]['workspaces'] }) {
  const [settings, setSettings] = useState<Settings>({
    ...defaultSettings(),
    profiles: [profile],
    activeProfileId: profile.id,
    selections: { [profile.id]: { workspaceId: 'ws_1', workspaces } },
  });
  const update = async (change: (s: Settings) => Settings) => {
    const next = change(settings);
    setSettings(next);
    return next;
  };
  return <ChatShell profile={profile} settings={settings} update={update} onAuthError={vi.fn()} />;
}

describe('ChatShell card responses', () => {
  it('queues the continuation for the workspace the card was answered in, even after a switch', async () => {
    render(<Shell />);
    await waitFor(() => expect(captured.respond).toBeDefined());
    const card = { id: 'act_1', kind: 'secret_request', status: 'pending' } as unknown as UiActionCard;

    let pending: ReturnType<RespondFn> | undefined;
    act(() => {
      pending = captured.respond!(card, { response: { fields: {} } });
    });
    fireEvent.change(screen.getByTestId('workspace-select'), { target: { value: 'ws_2' } });
    await waitFor(() => expect((screen.getByTestId('workspace-select') as HTMLSelectElement).value).toBe('ws_2'));

    await act(async () => {
      respondResult({ action: { ...card, status: 'resolved' }, replayed: false, continuation: { session_key: 's1', agent_key: 'super-agent', setup_action_id: 'act_1' } });
      await pending;
    });

    await waitFor(async () =>
      expect(await loadPendingContinuations()).toEqual([{ profile_id: 'p_1', workspace_id: 'ws_1', session_key: 's1', agent_key: 'super-agent', setup_action_id: 'act_1' }]),
    );
  });

  it("rebuilds a lost response's continuation from the agent and session the card was answered in", async () => {
    const card = { id: 'act_2', kind: 'secret_request', status: 'pending' } as unknown as UiActionCard;
    fake.actions.mockImplementation(async () => [{ ...card, status: 'resolved' }]);
    render(<Shell workspaces={{ ws_1: { agentKey: 'super-agent', sessions: { 'super-agent': 's1', helper: 's2' } } }} />);
    await waitFor(() => expect(screen.getByTestId('agent-picker').textContent).toContain('Super Agent'));
    await waitFor(() => expect(captured.respond).toBeDefined());

    let pending: ReturnType<RespondFn> | undefined;
    act(() => {
      pending = captured.respond!(card, { response: { fields: {} } });
    });
    fireEvent.click(screen.getByTestId('agent-picker'));
    fireEvent.click(screen.getByRole('option', { name: /Helper/ }));
    await waitFor(() => expect(screen.getByTestId('agent-picker').textContent).toContain('Helper'));

    await act(async () => {
      respondFail(new DeweeApiError(0, 'network_error', 'Lost'));
      await pending;
    });

    await waitFor(async () =>
      expect(await loadPendingContinuations()).toEqual([{ profile_id: 'p_1', workspace_id: 'ws_1', session_key: 's1', agent_key: 'super-agent', setup_action_id: 'act_2' }]),
    );
    fake.actions.mockImplementation(async () => []);
  });
});
describe('ChatShell conversation drawer', () => {
  it('returns focus to the toggle when Escape or the close button closes it', async () => {
    render(<Shell />);
    const toggle = await screen.findByRole('button', { name: 'Conversations' });
    fireEvent.click(toggle);
    const dialog = await screen.findByRole('dialog', { name: 'Conversations' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(dialog.isConnected).toBe(false);
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(toggle);
  });

  it('opens the chosen conversation and moves focus to the composer', async () => {
    fake.sessions.mockImplementation(async () => ({ sessions: [{ key: 's9', title: 'Older chat' }], total: 1 }));
    render(<Shell />);
    fireEvent.click(await screen.findByRole('button', { name: 'Conversations' }));
    fireEvent.click(await screen.findByRole('button', { name: /Older chat/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /^Message / }));
    fake.sessions.mockImplementation(async () => ({ sessions: [] }));
  });
});