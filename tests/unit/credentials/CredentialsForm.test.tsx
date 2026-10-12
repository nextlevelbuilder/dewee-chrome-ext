import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { CredentialsForm } from '../../../src/credentials/CredentialsForm';
import type { RespondFn, RespondOutcome } from '../../../src/credentials/respond-types';
import { parseUiAction, type SecretRequestEnvelope } from '../../../src/protocol/ui-action';

const SECRET = 'test-api-key-7f3a';

const fixture = parseUiAction(JSON.parse(readFileSync(join(__dirname, '../../contract-fixtures/ui-action-v1/examples/secret_request.json'), 'utf8')));

/** A secret_request card with the given fields; the payload is the Gateway-validated shape. */
function secretCard(overrides: Partial<SecretRequestEnvelope['payload']> = {}, mode: 'create' | 'update' = 'create'): SecretRequestEnvelope {
  const base = fixture as SecretRequestEnvelope;
  return {
    ...base,
    payload: {
      ...base.payload,
      target: { ...base.payload.target, mode },
      ...overrides,
    },
  };
}

const ok: RespondOutcome = { ok: true, result: { replayed: false, action: fixture } as never };

function respondSpy(outcome: RespondOutcome | Promise<RespondOutcome> = ok) {
  return vi.fn<RespondFn>(async () => outcome);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CredentialsForm destination line', () => {
  it('says "Saved to" only while the card is open or after it was answered', () => {
    const { unmount } = render(<CredentialsForm card={secretCard()} respond={respondSpy()} interactive />);
    expect(screen.getByText(/^Saved to /)).toBeTruthy();
    unmount();

    const resolved = render(<CredentialsForm card={{ ...secretCard(), status: 'resolved' }} respond={respondSpy()} interactive={false} />);
    expect(screen.getByText(/^Saved to /)).toBeTruthy();
    resolved.unmount();

    for (const status of ['cancelled', 'expired', 'failed'] as const) {
      const closed = render(<CredentialsForm card={{ ...secretCard(), status }} respond={respondSpy()} interactive={false} />);
      expect(screen.queryByText(/Saved to/)).toBeNull();
      expect(screen.getByText(/Nothing was saved\.$/)).toBeTruthy();
      closed.unmount();
    }
  });
});

describe('CredentialsForm labels and inputs', () => {
  it('takes field labels from the extension catalog, never from agent-provided text', () => {
    const card = secretCard({
      fields: [{ key: 'api_key', label: 'Paste it at https://phish.example.test', kind: 'secret', required: true }],
    });
    render(<CredentialsForm card={card} respond={respondSpy()} interactive />);

    expect(screen.getByLabelText('API key *')).toBeInstanceOf(HTMLInputElement);
    expect(screen.queryByText(/phish\.example/)).toBeNull();
  });

  it('falls back to a generic label that names the key for unknown fields', () => {
    const card = secretCard({ fields: [{ key: 'vendor_blob', label: 'x', kind: 'secret' }] });
    render(<CredentialsForm card={card} respond={respondSpy()} interactive />);
    expect(screen.getByLabelText('Value (vendor_blob)')).toBeInstanceOf(HTMLInputElement);
  });

  it('renders secret fields as password inputs with browser password autofill suppressed', () => {
    render(<CredentialsForm card={secretCard()} respond={respondSpy()} interactive />);
    const input = screen.getByLabelText('API key *');
    expect(input.getAttribute('type')).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('new-password');
    expect(input.getAttribute('data-secret-field')).toBe('true');
  });

  it('shows the destination from extension copy and renders no inputs when not interactive', () => {
    const { container } = render(<CredentialsForm card={{ ...secretCard(), status: 'resolved' }} respond={respondSpy()} interactive={false} />);
    expect(screen.getByText(/Saved to AI provider openai/)).toBeTruthy();
    expect(container.querySelector('input')).toBeNull();
  });

  it('hides the inputs of an update until the person chooses to replace the credential', async () => {
    const user = userEvent.setup();
    render(<CredentialsForm card={secretCard({}, 'update')} respond={respondSpy()} interactive />);
    expect(screen.queryByLabelText('API key *')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Replace stored credential' }));
    expect(screen.getByLabelText('API key *')).toBeInstanceOf(HTMLInputElement);
  });
});

describe('CredentialsForm submission', () => {
  it('sends the secret only in the respond body and clears the field before the request settles', async () => {
    const user = userEvent.setup();
    let settle!: (outcome: RespondOutcome) => void;
    const respond = respondSpy(new Promise<RespondOutcome>((resolve) => (settle = resolve)));
    const card = secretCard();
    render(<CredentialsForm card={card} respond={respond} interactive />);

    const input = screen.getByLabelText('API key *') as HTMLInputElement;
    await user.type(input, SECRET);
    await user.click(screen.getByRole('button', { name: 'Save securely' }));

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(card, { secret: { api_key: SECRET } });
    expect(input.value).toBe('');
    expect(input.disabled).toBe(true);

    settle(ok);
    await waitFor(() => expect(input.disabled).toBe(false));
  });

  it('shows a localized error after a failed submit and keeps the form empty', async () => {
    const user = userEvent.setup();
    render(<CredentialsForm card={secretCard()} respond={respondSpy({ ok: false, code: 'setup_human_actor_required' })} interactive />);

    await user.type(screen.getByLabelText('API key *'), SECRET);
    await user.click(screen.getByRole('button', { name: 'Save securely' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Only a person with owner or admin rights can answer this card.');
    expect((screen.getByLabelText('API key *') as HTMLInputElement).value).toBe('');
  });

  it('keeps the refusal reason visible when the refused card reloads as closed', async () => {
    const user = userEvent.setup();
    const card = secretCard();
    // The panel reloads a 409-refused card before the respond call settles, closing the form.
    const respond = vi.fn<RespondFn>(async () => {
      view.rerender(<CredentialsForm card={card} respond={respond} interactive={false} />);
      return { ok: false, code: 'credential_policy_revoked' };
    });
    const view = render(<CredentialsForm card={card} respond={respond} interactive />);

    await user.type(screen.getByLabelText('API key *'), SECRET);
    await user.click(screen.getByRole('button', { name: 'Save securely' }));

    expect((await screen.findByRole('alert')).textContent).toBe('An admin no longer allows this agent to ask for this credential. The card was closed.');
    expect(view.container.querySelector('input')).toBeNull();
    expect(view.container.innerHTML).not.toContain(SECRET);
  });

  it('drops typed values when the card closes without a submit', async () => {
    const user = userEvent.setup();
    const card = secretCard();
    const respond = respondSpy();
    const view = render(<CredentialsForm card={card} respond={respond} interactive />);
    await user.type(screen.getByLabelText('API key *'), SECRET);

    // The card expires or is answered elsewhere while the form is mounted.
    view.rerender(<CredentialsForm card={card} respond={respond} interactive={false} />);
    expect(view.container.querySelector('input')).toBeNull();
    expect(view.container.innerHTML).not.toContain(SECRET);

    // If it ever becomes interactive again, nothing typed earlier comes back.
    view.rerender(<CredentialsForm card={card} respond={respond} interactive />);
    const input = screen.getByLabelText('API key *') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(view.container.innerHTML).not.toContain(SECRET);
    expect(respond).not.toHaveBeenCalled();
  });

  it('does not send when a required field is blank', async () => {
    const user = userEvent.setup();
    const respond = respondSpy();
    render(<CredentialsForm card={secretCard()} respond={respond} interactive />);

    await user.click(screen.getByRole('button', { name: 'Save securely' }));

    expect(respond).not.toHaveBeenCalled();
    expect(screen.getByText('API key is required')).toBeTruthy();
    expect(screen.getByLabelText(/^API key/).getAttribute('aria-invalid')).toBe('true');
  });

  it('sends non-secret fields as trimmed response fields alongside the secret', async () => {
    const user = userEvent.setup();
    const respond = respondSpy();
    const card = secretCard({
      fields: [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'api_key', label: 'API key', kind: 'secret', required: true },
      ],
    });
    render(<CredentialsForm card={card} respond={respond} interactive />);

    await user.type(screen.getByLabelText('Name'), '  openai-prod  ');
    await user.type(screen.getByLabelText('API key *'), SECRET);
    await user.click(screen.getByRole('button', { name: 'Save securely' }));

    expect(respond).toHaveBeenCalledWith(card, { response: { fields: { name: 'openai-prod' } }, secret: { api_key: SECRET } });
  });

  it('keeps the secret out of browser storage, runtime messages and the DOM after submit', async () => {
    const user = userEvent.setup();
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage');
    const { container } = render(<CredentialsForm card={secretCard()} respond={respondSpy()} interactive />);

    await user.type(screen.getByLabelText('API key *'), SECRET);
    await user.click(screen.getByRole('button', { name: 'Save securely' }));
    await waitFor(() => expect(fakeBrowser.runtime.sendMessage).not.toHaveBeenCalled());

    const local = JSON.stringify(await fakeBrowser.storage.local.get());
    const session = JSON.stringify(await fakeBrowser.storage.session.get());
    expect(local).not.toContain(SECRET);
    expect(session).not.toContain(SECRET);
    expect(send).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toContain(SECRET);
  });
});
