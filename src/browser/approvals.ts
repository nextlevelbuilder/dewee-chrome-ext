/**
 * Local confirmation of high-risk actions. A request is shown as a card in every open side panel
 * of this browser; it waits for the person. It is denied, never approved, when no panel is open,
 * when the last panel closes, when the command is cancelled or reaches its deadline.
 */
export interface ApprovalRequest {
  id: string;
  agentName: string;
  channel: string;
  action: 'click' | 'type';
  domain: string;
  /** Accessible name of the target element, shown as plain text. */
  target: string;
  /** `type` with `submit: true`. */
  submit: boolean;
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
