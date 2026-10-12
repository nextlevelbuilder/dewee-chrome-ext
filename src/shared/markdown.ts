/**
 * Assistant text is Markdown written by a model, so it is untrusted: render with `marked`, then
 * sanitize with DOMPurify. Links open in a new tab without referrer; only http(s) and mailto
 * survive. Images are dropped (remote images would leak the viewer's IP and act as beacons).
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

const ALLOWED_TAGS = [
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'li', 'ol', 'p', 'pre', 's',
  'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
];

let hooked = false;
function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') return;
    const href = node.getAttribute('href') ?? '';
    if (!/^(https?:|mailto:)/i.test(href)) {
      node.removeAttribute('href');
      return;
    }
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  });
}

export function renderMarkdown(text: string): string {
  ensureHooks();
  const html = marked.parse(text, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR: ['href', 'title', 'target', 'rel'], ALLOW_DATA_ATTR: false });
}
