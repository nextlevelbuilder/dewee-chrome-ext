/**
 * "Ask Dewee" about selected page text. The opt-in content script sends one `ask.selection` message
 * when the person clicks its button; the service worker opens the side panel and keeps the draft
 * in `storage.session` until the panel puts it in the composer. Nothing is sent to Dewee until the
 * person adds a question and presses Send.
 */
import { z } from 'zod';

/** Longest selection kept; the rest is cut with a marker. */
export const MAX_SELECTION = 4000;
export const ASK_DRAFT_KEY = 'askDraft';
/** Site access the feature asks for when it is turned on (the manifest lists it as optional). */
export const ASK_ORIGINS = ['https://*/*'];
/** A draft older than this is dropped instead of filling the composer later by surprise. */
export const ASK_DRAFT_TTL_MS = 5 * 60_000;

const httpUrl = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  });

export const askSelectionSchema = z.object({
  type: z.literal('ask.selection'),
  text: z.string().trim().min(1).max(MAX_SELECTION * 2),
  url: httpUrl,
  title: z.string().max(1000).default(''),
});
export type AskSelection = z.infer<typeof askSelectionSchema>;

export const askDraftSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  createdAt: z.number(),
  /** The window whose side panel was opened; other windows' panels leave the draft alone. */
  windowId: z.number().int(),
});
export type AskDraft = z.infer<typeof askDraftSchema>;

const SECRET_PARAM = /pass(word)?|secret|token|key|auth|code|session|sig(nature)?|state|ticket|jwt|credential|^(t|s|k|sid|x-amz-.*|x-goog-.*)$/i;

/** The page address without its fragment and without query values that could carry a credential. */
export function shareableUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  url.username = '';
  url.password = '';
  for (const name of [...url.searchParams.keys()]) if (SECRET_PARAM.test(name)) url.searchParams.delete(name);
  return url.toString();
}

/** Composer text for a selection: the quote, then where it came from, then an empty line for the question. */
export function formatAskDraft({ text, url, title }: Pick<AskSelection, 'text' | 'url' | 'title'>): string {
  const clipped = text.length > MAX_SELECTION ? `${text.slice(0, MAX_SELECTION)}…` : text;
  const quote = clipped
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
  const name = title.replace(/\s+/g, ' ').trim().slice(0, 200);
  const link = shareableUrl(url);
  return `${quote}\n\n${name ? `Source: ${name} — ${link}` : `Source: ${link}`}\n\n`;
}
