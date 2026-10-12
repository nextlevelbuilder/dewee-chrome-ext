import { renderMarkdown } from '../../../src/shared/markdown';

function dom(markdown: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = renderMarkdown(markdown);
  return root;
}

describe('renderMarkdown', () => {
  it('renders common Markdown', () => {
    const root = dom('**bold** and `code`');
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('code')?.textContent).toBe('code');
  });

  it('removes script elements and inline event handlers', () => {
    const html = renderMarkdown('hi <script>alert(1)</script><p onclick="alert(2)">para</p><span onmouseover="x()">s</span>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onmouseover');
    expect(html).toContain('para');
  });

  it('drops images, which would otherwise load remote content', () => {
    const html = renderMarkdown('![pixel](https://tracker.example.test/p.png) <img src="x" onerror="alert(3)">');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('tracker.example.test');
  });

  it('removes javascript: links but keeps their text', () => {
    const root = dom('[click](javascript:alert(4))');
    expect(root.innerHTML).not.toContain('javascript:');
    expect(root.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(root.textContent).toContain('click');
  });

  it('keeps http, https and mailto links with the safe attributes', () => {
    const root = dom('[site](https://example.test/a) [plain](http://example.test/b) [mail](mailto:support@example.test)');
    const links = [...root.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://example.test/a',
      'http://example.test/b',
      'mailto:support@example.test',
    ]);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    }
  });

  it('drops relative and other-scheme links', () => {
    const root = dom('<a href="/settings">settings</a> <a href="data:text/html,hi">data</a>');
    for (const link of root.querySelectorAll('a')) expect(link.hasAttribute('href')).toBe(false);
  });

  it('drops tags outside the allow-list', () => {
    const html = renderMarkdown('<iframe src="https://example.test"></iframe><form action="x"><input name="y"></form>');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
  });
});
