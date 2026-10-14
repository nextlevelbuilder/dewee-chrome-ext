/**
 * Receipt of `browser.command` events: validate, acknowledge, execute, report. The ack goes out as
 * soon as the command is valid (before any work); exactly one result follows. A command id seen
 * before is never executed again, so a duplicate event cannot repeat a side effect. Cancellation,
 * Pause/Stop, revocation and the deadline abort the running command; if it may already have had
 * an effect the result is `outcome_unknown`, and the agent has to snapshot again.
 *
 * At-most-once holds only while this worker lives: the seen ids are kept in memory. After the
 * service worker restarts, not running a command twice relies on the Gateway, which does not
 * resend a command it already dispatched (it reports `outcome_unknown` or `timeout` instead).
 */
import { CommandError, type ExecutionContext } from './executor';
import { ACTION_CLASS, actionResultSchemas, parseCommand, type BrowserCommand, type BrowserErrorCode, type MethodParams } from './protocol';

export const MAX_IN_FLIGHT = 8;
/** Longest a single command may run here, whatever deadline it carries (also keeps `setTimeout` in range). */
export const MAX_COMMAND_MS = 120_000;
const MAX_SEEN = 1_000;

export interface RunnerDeps {
  ack(params: MethodParams<'browser.command.ack'>): Promise<unknown>;
  result(params: MethodParams<'browser.command.result'>): Promise<unknown>;
  execute(command: BrowserCommand, signal: AbortSignal, context: ExecutionContext): Promise<Record<string, unknown>>;
  /** The device this socket is attached as; commands for another device are refused. */
  deviceId(): string | null;
  now?(): number;
}

interface Running {
  command: BrowserCommand;
  controller: AbortController;
  context: ExecutionContext;
}

const MESSAGES: Partial<Record<BrowserErrorCode, string>> = {
  cancelled: 'The command was cancelled',
  grant_revoked: 'The person revoked the grant; ask them to grant access again',
  grant_expired: 'The grant expired; ask the person to grant access again',
  timeout: 'The command reached its deadline',
  outcome_unknown: 'The command was interrupted after it may have changed the page; take a new snapshot',
  invalid_params: 'The command is not valid',
  busy: 'Too many commands are running on this device',
  permission_denied: 'The command is for another device',
  internal: 'The command failed in the extension',
};

export class CommandRunner {
  private readonly running = new Map<string, Running>();
  private readonly seen = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? Date.now;
  }

  get size(): number {
    return this.running.size;
  }

  /** Handles one `browser.command` payload; resolves when its result was sent (or could not be). */
  async handle(payload: unknown): Promise<void> {
    const parsed = parseCommand(payload);
    if (!parsed.ok) {
      if (parsed.commandId && this.remember(parsed.commandId)) await this.fail(parsed.commandId, 'invalid_params');
      return;
    }
    const command = parsed.command;
    if (!this.remember(command.command_id)) return;
    if (command.device_id !== this.deps.deviceId()) return this.fail(command.command_id, 'permission_denied');
    const deadline = Date.parse(command.deadline);
    if (deadline <= this.now()) return this.fail(command.command_id, 'timeout');
    if (this.running.size >= MAX_IN_FLIGHT) return this.fail(command.command_id, 'busy');

    const controller = new AbortController();
    const context: ExecutionContext = { sideEffect: false };
    this.running.set(command.command_id, { command, controller, context });
    // The ack frame is written before any work starts.
    void this.deps.ack({ command_id: command.command_id }).catch(() => undefined);
    const timer = setTimeout(() => controller.abort(new CommandError('timeout')), Math.min(deadline - this.now(), MAX_COMMAND_MS));
    try {
      const result = await this.deps.execute(command, controller.signal, context);
      if (controller.signal.aborted) throw controller.signal.reason;
      const checked = actionResultSchemas[command.action].safeParse(result);
      // A result that cannot be reported (say, a page url over the limit) after an interaction does
      // not undo it: the action may have run, so the agent must not simply repeat it.
      if (!checked.success) throw new CommandError(ACTION_CLASS[command.action] === 'interact' || context.sideEffect ? 'outcome_unknown' : 'internal');
      await this.deps.result({ command_id: command.command_id, ok: true, result: checked.data as Record<string, unknown> }).catch(() => undefined);
    } catch (error) {
      await this.fail(command.command_id, this.codeFor(error, controller.signal, context), error);
    } finally {
      clearTimeout(timer);
      this.running.delete(command.command_id);
    }
  }

  cancel(commandId: string, code: BrowserErrorCode = 'cancelled'): boolean {
    const running = this.running.get(commandId);
    if (!running) return false;
    running.controller.abort(new CommandError(code));
    return true;
  }

  /** Aborts the running commands that match (a revoked grant, a closed tab, the person's own input). */
  cancelWhere(match: (command: BrowserCommand) => boolean, code: BrowserErrorCode = 'cancelled'): number {
    let count = 0;
    for (const { command } of [...this.running.values()]) {
      if (match(command) && this.cancel(command.command_id, code)) count += 1;
    }
    return count;
  }

  cancelAll(code: BrowserErrorCode = 'cancelled'): number {
    return this.cancelWhere(() => true, code);
  }

  private codeFor(error: unknown, signal: AbortSignal, context: ExecutionContext): BrowserErrorCode {
    const reason = signal.aborted && signal.reason instanceof CommandError ? signal.reason.code : null;
    if (reason) return context.sideEffect ? 'outcome_unknown' : reason;
    return error instanceof CommandError ? error.code : 'internal';
  }

  private async fail(commandId: string, code: BrowserErrorCode, error?: unknown): Promise<void> {
    // Messages are fixed text per code: page content, typed text and element names never go in them.
    const own = error instanceof CommandError && error.code === code && error.message !== code ? error.message : undefined;
    const message = own ?? MESSAGES[code] ?? code;
    await this.deps.result({ command_id: commandId, ok: false, error: { code, message: message.slice(0, 500) } }).catch(() => undefined);
  }

  private remember(commandId: string): boolean {
    if (this.seen.has(commandId)) return false;
    this.seen.add(commandId);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }
}
