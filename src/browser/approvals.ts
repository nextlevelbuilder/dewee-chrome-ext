/**
 * Local confirmation of high-risk actions. A request is shown as a card in every open side panel
 * of this browser; it waits for the person. It is denied, never approved, when no panel is open,
 * when the last panel closes, when the command is cancelled or reaches its deadline.
 */
export interface ApprovalRequest {
  id: string;
  agentName: string;
  channel: string;
  /** `press` is Enter, which can submit what is focused. */
  action: 'click' | 'type' | 'press';
  domain: string;
  /** Accessible name of the target element, shown as plain text. */
  target: string;
  /** `type` with `submit: true`, or Enter. */
  submit: boolean;
  /**
   * Start of the text `type` will enter and submit, so the person sees what would be sent. It
   * lives only in this request and the panel state; it is never stored or logged. Never set for
   * sensitive fields, which are refused before any approval.
   */
  preview?: string;
}

/** Longest typed-text preview shown on an approval card. */
export const APPROVAL_PREVIEW_MAX = 160;

export function approvalPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > APPROVAL_PREVIEW_MAX ? `${flat.slice(0, APPROVAL_PREVIEW_MAX - 1)}…` : flat;
}

interface Waiting {
  request: ApprovalRequest;
  resolve(approved: boolean): void;
}

export class ApprovalBroker {
  private readonly waiting = new Map<string, Waiting>();
  private panels = 0;

  constructor(private readonly onChange: () => void) {}

  get pending(): ApprovalRequest[] {
    return [...this.waiting.values()].map((w) => w.request);
  }

  /** Counts open side panels (runtime ports); when the last one closes every open request is denied. */
  panelOpened(): void {
    this.panels += 1;
  }

  panelClosed(): void {
    this.panels = Math.max(0, this.panels - 1);
    if (this.panels === 0) this.denyAll();
  }

  get hasPanel(): boolean {
    return this.panels > 0;
  }

  request(details: Omit<ApprovalRequest, 'id'>, signal: AbortSignal): Promise<boolean> {
    if (!this.hasPanel || signal.aborted) return Promise.resolve(false);
    const request: ApprovalRequest = { id: crypto.randomUUID(), ...details };
    return new Promise<boolean>((resolve) => {
      const settle = (approved: boolean) => {
        if (!this.waiting.delete(request.id)) return;
        signal.removeEventListener('abort', onAbort);
        resolve(approved);
        this.onChange();
      };
      const onAbort = () => settle(false);
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(request.id, { request, resolve: settle });
      this.onChange();
    });
  }

  /** The person's answer from a panel. Unknown ids (already settled) are ignored. */
  answer(id: string, approved: boolean): boolean {
    const waiting = this.waiting.get(id);
    if (!waiting) return false;
    waiting.resolve(approved);
    return true;
  }

  denyAll(): void {
    for (const waiting of [...this.waiting.values()]) waiting.resolve(false);
  }
}
