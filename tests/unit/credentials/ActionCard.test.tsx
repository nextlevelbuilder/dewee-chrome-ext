import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ActionCard } from '../../../src/credentials/ActionCard';
import type { RespondFn } from '../../../src/credentials/respond-types';
import { parseUiAction, type UiActionCard } from '../../../src/protocol/ui-action';

const fixture = parseUiAction(
  JSON.parse(readFileSync(join(__dirname, '../../contract-fixtures/ui-action-v1/examples/secret_request.json'), 'utf8')),
) as UiActionCard;

const respond = vi.fn<RespondFn>(async () => ({ ok: true, result: { replayed: false, action: fixture } as never }));

/** Builds a card from the fixture envelope, overriding top-level fields. */
const card = (overrides: Record<string, unknown>) => ({ ...fixture, ...overrides }) as UiActionCard;

describe('ActionCard', () => {
  it('renders agent-written body text as plain text, never as HTML', () => {
    const { container } = render(<ActionCard card={card({ body: '<img src=x onerror=alert(1)> **not bold**' })} respond={respond} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)> **not bold**')).toBeTruthy();
  });

  it('shows a pending card whose expiry has passed as expired, with no form', () => {
    const past = card({ created_at: '2020-01-01T00:00:00Z', expires_at: '2020-01-02T00:00:00Z' });
    const { container } = render(<ActionCard card={past} respond={respond} />);
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(container.querySelector('input')).toBeNull();
  });

  it('shows a resolved secret card as done, with the saved notice and no form', () => {
    const { container } = render(<ActionCard card={card({ status: 'resolved' })} respond={respond} />);
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText(/The agent only receives a reference/)).toBeTruthy();
    expect(container.querySelector('input')).toBeNull();
  });

  it('offers confirm and cancel for an allowed command preview but not for a blocked one', () => {
    const preview = (policy_outcome: string): UiActionCard =>
      ({
        ...fixture,
        kind: 'command_preview',
        // Open regardless of today's date: the fixture's own expiry is a fixed moment.
        expires_at: '2999-01-01T00:00:00Z',
        payload: { command: ['dewee', 'agents', 'list'], policy_outcome },
      }) as unknown as UiActionCard;

    const { unmount } = render(<ActionCard card={preview('allowed')} respond={respond} />);
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
    unmount();

    render(<ActionCard card={preview('blocked')} respond={respond} />);
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.getByText('dewee agents list')).toBeTruthy();
  });

  it('shows setup progress as a labelled progress element', () => {
    const progress = {
      ...fixture,
      kind: 'setup_progress',
      payload: { plan_revision: 1, completed: 2, total: 5 },
    } as unknown as UiActionCard;
    render(<ActionCard card={progress} respond={respond} />);
    expect(screen.getByLabelText('2/5')).toBeTruthy();
  });

  it('explains a respond refused because an admin revoked the credential policy', async () => {
    const oauth = parseUiAction({
      ...JSON.parse(readFileSync(join(__dirname, '../../contract-fixtures/ui-action-v1/examples/oauth_request.json'), 'utf8')),
      expires_at: '2999-01-01T00:00:00Z',
    }) as UiActionCard;
    const refused = vi.fn<RespondFn>(async () => ({ ok: false, code: 'credential_policy_revoked' }));
    render(<ActionCard card={oauth} respond={refused} />);
    fireEvent.click(screen.getByRole('button', { name: 'I have signed in' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(/no longer allows this agent/));
  });
});
