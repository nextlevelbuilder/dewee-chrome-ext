import { APPROVAL_PREVIEW_MAX, approvalPreview, ApprovalBroker } from '@/browser/approvals';

describe('approvalPreview', () => {
  it('flattens whitespace and keeps short text whole', () => {
    expect(approvalPreview('  Hello\n\tthere  ')).toBe('Hello there');
    expect(approvalPreview('')).toBe('');
  });

  it('clips long text to the preview limit', () => {
    const preview = approvalPreview('a'.repeat(APPROVAL_PREVIEW_MAX + 50));
    expect(preview).toHaveLength(APPROVAL_PREVIEW_MAX);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('ApprovalBroker', () => {
  const details = { agentName: 'Researcher', channel: 'telegram', action: 'press' as const, domain: 'shop.example.test', target: 'Message', submit: true };

  it('denies at once without an open panel', async () => {
    const broker = new ApprovalBroker(() => undefined);
    await expect(broker.request(details, new AbortController().signal)).resolves.toBe(false);
    expect(broker.pending).toEqual([]);
  });

  it('keeps the preview only while the request is pending', async () => {
    const broker = new ApprovalBroker(() => undefined);
    broker.panelOpened();
    const answer = broker.request({ ...details, action: 'type', preview: 'Hello there' }, new AbortController().signal);
    expect(broker.pending).toMatchObject([{ action: 'type', preview: 'Hello there' }]);
    broker.answer(broker.pending[0]?.id ?? '', true);
    await expect(answer).resolves.toBe(true);
    expect(broker.pending).toEqual([]);
  });

  it('denies a pending request when the command is cancelled', async () => {
    const broker = new ApprovalBroker(() => undefined);
    broker.panelOpened();
    const controller = new AbortController();
    const answer = broker.request(details, controller.signal);
    controller.abort();
    await expect(answer).resolves.toBe(false);
  });
});
