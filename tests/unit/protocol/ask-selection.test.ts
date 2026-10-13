import { askDraftSchema, askSelectionSchema, formatAskDraft, MAX_SELECTION, shareableUrl } from '../../../src/protocol/ask-selection';

describe('ask.selection message', () => {
  it('accepts a selection from an http(s) page and defaults the title', () => {
    const parsed = askSelectionSchema.parse({ type: 'ask.selection', text: ' quoted ', url: 'https://example.com/a' });
    expect(parsed).toEqual({ type: 'ask.selection', text: 'quoted', url: 'https://example.com/a', title: '' });
  });

  it.each([
    ['an empty selection', { text: '   ', url: 'https://example.com' }],
    ['a non-web address', { text: 'x', url: 'javascript:alert(1)' }],
    ['an extension page', { text: 'x', url: 'chrome-extension://abc/options.html' }],
    ['a huge selection', { text: 'x'.repeat(MAX_SELECTION * 2 + 1), url: 'https://example.com' }],
    ['another message type', { type: 'auth.signOut', text: 'x', url: 'https://example.com' }],
  ])('rejects %s', (_label, patch) => {
    expect(askSelectionSchema.safeParse({ type: 'ask.selection', ...patch }).success).toBe(false);
  });

  it('requires an id, text, time and window for a stored draft', () => {
    expect(askDraftSchema.safeParse({ id: 'd1', text: 'x', createdAt: 1, windowId: 2 }).success).toBe(true);
    expect(askDraftSchema.safeParse({ id: 'd1', text: 'x', createdAt: 1 }).success).toBe(false);
  });
});

describe('shareableUrl', () => {
  it('drops short and signed-URL credential parameters', () => {
    expect(shareableUrl('https://s3.example.com/f?X-Amz-Credential=a&X-Amz-Signature=b&t=c&sid=d&credential=e&lang=vi')).toBe('https://s3.example.com/f?lang=vi');
  });

  it('drops the fragment, credentials in the address and secret-looking query values', () => {
    expect(shareableUrl('https://ann:pw@example.com/p?q=dewee&token=abc&page=2&code=xyz#section')).toBe('https://example.com/p?q=dewee&page=2');
  });

  it('keeps a plain address unchanged', () => {
    expect(shareableUrl('https://example.com/docs/intro')).toBe('https://example.com/docs/intro');
  });
});

describe('formatAskDraft', () => {
  it('quotes every line, names the source and leaves a blank line for the question', () => {
    expect(formatAskDraft({ text: 'First line\r\n\r\nThird line', url: 'https://example.com/a?session=s#top', title: '  Example   page ' })).toBe(
      '> First line\n>\n> Third line\n\nSource: Example page — https://example.com/a\n\n',
    );
  });

  it('uses the address alone when the page has no title and clips a long selection', () => {
    const draft = formatAskDraft({ text: 'y'.repeat(MAX_SELECTION + 50), url: 'https://example.com/', title: '' });
    expect(draft).toContain(`> ${'y'.repeat(MAX_SELECTION)}…`);
    expect(draft).toContain('Source: https://example.com/');
  });
});