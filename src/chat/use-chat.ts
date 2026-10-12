/**
 * Chat engine for one conversation. Rules that keep runs from duplicating:
 * - A user message is sent once and never re-sent automatically; retry is a user action.
 * - "Send again" is offered only when the server provably did not receive the message: the panel
 *   failed before calling fetch, the fetch was rejected while the browser was offline, or the
 *   server refused it with a 4xx. Every other failure is uncertain: the turn stays shown once as
 *   `delivery_unconfirmed` with a reload action (or "Show conversations" in a new chat), and is
 *   dropped only when the server history provably holds it.
 * - One reconcile loop runs per conversation; only its owner writes state, and only it sets idle.
 * - Reopening the panel never re-sends a message: it loads history, run status and open cards.
 * - Card continuations are queued per profile, workspace and setup action, persisted in
 *   `storage.session` (IDs only) and sent automatically, one at a time, while their own session is
 *   shown and idle. Unlike a user message, a continuation may be auto-sent and re-sent: the Gateway
 *   delivers each at most once. An item leaves the queue only when the agent provably got it
 *   (`message.completed`, 409 `continuation_sent`, `chat.error` `setup_result_delivered`) or when
 *   it can never succeed (400, 404, 410, and a 403 other than a key problem the person can fix).
 *   409 `continuation_in_progress` (another request holds the send lease) is retried with backoff
 *   for about 11 minutes from the first such answer (stored with the item). Any other failure (a
 *   `chat.error`, an early close, a drop, Stop) holds the item: it is stored as held and waits for
 *   "Continue", because the Gateway releases the lease when a run fails before the result is saved.
 *   A conversation switch or unmount is not a failure: the item stays unheld and is sent again.
 */
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { DeweeClient } from '@/api/dewee-client';
import { DeweeApiError, isApiError } from '@/api/errors';
import type { Continuation, HistoryMessage } from '@/api/schemas';
import type { UiActionCard } from '@/protocol/ui-action';
import { chatReducer, initialChatState, localId, type ChatMessage, type ChatState } from './chat-state';
import { fetchSessionHistory } from './history';
import {
  addPendingContinuation,
  loadPendingContinuations,
  pendingKey,
  removePendingContinuation,
  watchPendingContinuations,
  type PendingContinuation,
} from './pending-continuations';

export interface ChatContext {
  client: DeweeClient;
  profileId: string;
  workspaceId: string;
  agentKey: string;
  sessionKey?: string;
}

export interface ChatControls {
  state: ChatState;
  /** Starts sending `text`. False when it was refused locally (another stream started), so nothing left. */
  send(text: string): boolean;
  /**
   * Queues a card continuation; it is sent once its session is shown and idle. `scope` is the
   * profile and workspace the card was answered in (default: the current ones).
   */
  continueWith(continuation: Continuation, scope?: ContinuationScope): Promise<void>;
  stop(): Promise<void>;
  loadOlder(): Promise<void>;
  /** Reloads the conversation; re-checks turns whose delivery could not be confirmed. */
  reload(): Promise<void>;
  /** Sends again what a failed message offers: its text ("Send again") or its continuation ("Continue"). */
  retry(message: ChatMessage): Promise<void>;
  updateCard(card: UiActionCard): void;
}

const RECONCILE_INTERVAL_MS = 2_000;
/** Polls at the fast interval; a run that is still going after them is polled at the slow one. */
const RECONCILE_FAST_POLLS = 90;
const RECONCILE_SLOW_INTERVAL_MS = 15_000;
/** Consecutive failed status polls (while online) before the loop gives up and reads history. */
const RECONCILE_MAX_FAILURES = 30;
const STOP_GRACE_MS = 5_000;
/** Waits before re-sending a continuation answered 409 `continuation_in_progress`; the last repeats. */
export const IN_PROGRESS_RETRY_MS = [5_000, 15_000, 30_000, 60_000];
/** How long after the first in-progress answer the panel keeps retrying; a lease goes stale after 10 min. */
export const IN_PROGRESS_LIMIT_MS = 11 * 60_000;

export interface ContinuationScope {
  profileId: string;
  workspaceId: string;
}

/** Automatic retries of one continuation that another request is sending. */
interface InProgressWait {
  since: number;
  attempts: number;
  at: number;
}

/** Refusals of a continuation that can never succeed: the card or its continuation is invalid, gone or not allowed. */
const DEAD_CONTINUATION_STATUSES = new Set([400, 403, 404, 410]);
/** 403 codes the person can fix (by fixing their key), so the item is kept for "Continue" instead. */
const FIXABLE_REFUSAL_CODES = new Set(['scope_required', 'owner_binding_required']);

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** Status-0 codes of a request that may have reached the server. Other status-0 codes come from the panel. */
const TRANSPORT_CODES = new Set(['network_error', 'timeout', 'stream_stalled', 'connection_lost', 'protocol_error', 'invalid_response', 'runtime_request_failed']);

/**
 * True only when the server provably did not receive the request: the panel failed before the
 * fetch, the fetch was rejected while the browser reported offline, or the server refused it with
 * a 4xx. A 5xx, a stall, a drop after the response or a fetch rejected while online is uncertain.
 */
function notReceived(error: unknown, responded: boolean): boolean {
  if (responded) return false;
  // The client wraps every fault after the response, so a raw error means fetch was never called.
  if (!isApiError(error)) return true;
  if (error.afterResponse) return false;
  if (error.status >= 400 && error.status < 500) return error.code !== 'continuation_sent';
  if (error.status !== 0) return false;
  if (error.code === 'network_error') return isOffline();
  return !TRANSPORT_CODES.has(error.code);
}

/** Resolves when the browser is back online, or once `live()` turns false (conversation switch, unmount). */
function waitForOnline(live: () => boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      window.removeEventListener('online', done);
      clearInterval(check);
      resolve();
    };
    // A local check only, never a request. It also catches a missed `online` event.
    const check = setInterval(() => {
      if (!live() || !isOffline()) done();
    }, RECONCILE_INTERVAL_MS);
    window.addEventListener('online', done);
  });
}

/**
 * The server history when a turn was sent: the last message (ids are `m<position>`) as an anchor,
 * plus the user turns the server confirmed since (`chat.started`). Null when unknown.
 */
interface Baseline {
  position: number;
  anchor?: { role: string; content: string };
  confirmed: number;
}

/** A turn sent without proof that the server got it, kept until a reconcile settles it. */
interface Unconfirmed {
  localId: string;
  text?: string;
  continuation?: Continuation;
  code: string;
  message: string;
  baseline: Baseline | null;
}

const positionOf = (message: HistoryMessage): number | null => {
  const match = /^m(\d+)$/.exec(message.id ?? '');
  return match ? Number(match[1]) : null;
};

function baselineOf(history: HistoryMessage[]): Baseline | null {
  let position = -1;
  let anchor: Baseline['anchor'];
  for (const message of history) {
    const at = positionOf(message);
    if (at === null) return null;
    if (at > position) {
      position = at;
      anchor = { role: message.role, content: message.content };
    }
  }
  return { position, anchor, confirmed: 0 };
}

const sameText = (a: string, b: string) => a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ');

/**
 * True only when the history provably holds `text` as a user turn sent after the baseline: the
 * anchor is still at its position and a matching user turn follows it. After compaction or
 * renumbered ids the anchor is gone, so the turn stays unconfirmed rather than guessed.
 */
function holdsTurn(history: HistoryMessage[], text: string, baseline: Baseline | null): boolean {
  if (!baseline) return false;
  if (baseline.anchor) {
    const { role, content } = baseline.anchor;
    const anchor = history.find((m) => positionOf(m) === baseline.position);
    if (!anchor || anchor.role !== role || !sameText(anchor.content, content)) return false;
  }
  // Server-written (injected) turns are not the person's messages, so they never count.
  const after = history.filter((m) => m.role === 'user' && !m.injected && (positionOf(m) ?? -1) > baseline.position).slice(baseline.confirmed);
  return after.some((m) => sameText(m.content, text));
}

const turnIdOf = (message: ChatMessage) => message.id.replace(/-reply$/, '');

export function useChat(ctx: ChatContext | null, hooks: { onSessionKey(key: string): void; onAuthError(error: DeweeApiError): void }): ChatControls {
  const [state, dispatch] = useReducer(chatReducer, ctx?.sessionKey, initialChatState);
  const stateRef = useRef(state);
  const ctxRef = useRef(ctx);
  const hooksRef = useRef(hooks);
  // Layout effects run before the effects below, so callbacks always read the committed values.
  useLayoutEffect(() => {
    stateRef.current = state;
    ctxRef.current = ctx;
    hooksRef.current = hooks;
  });
  const streamRef = useRef<AbortController | null>(null);
  /** Bumped when a stream fully ends, so a queued continuation can start after it. */
  const [streamsEnded, setStreamsEnded] = useState(0);
  /** Lets `loadSession` start a reconcile without the two callbacks depending on each other. */
  const reconcileRef = useRef<(sessionKey: string, unconfirmed?: Unconfirmed) => Promise<void>>(async () => {});
  /** Bumped on every context switch so late results of an old conversation are dropped. */
  const epochRef = useRef(0);
  /** Ends reconcile loops and offline waits once the panel unmounts. */
  const mountedRef = useRef(true);
  /** The running reconcile loop's identity; null when none runs. A new owner retires the old one. */
  const ownerRef = useRef<object | null>(null);
  /** The server history as last seen, for deciding later whether a turn arrived. */
  const baselineRef = useRef<Baseline | null>(null);
  /** Turns left as `delivery_unconfirmed`, by local id; every reconcile and reload checks them again. */
  const uncheckedRef = useRef(new Map<string, Unconfirmed>());
  /** Continuations not yet delivered, for every session; each is also its own `storage.session` item. */
  const queueRef = useRef<PendingContinuation[]>([]);
  /**
   * Queued continuations (by `pendingKey`) that wait for "Continue" instead of being sent again. Kept
   * across conversation switches and stored with the item, so a reopened panel holds it too.
   */
  const heldRef = useRef(new Set<string>());
  /** Pending sleeps of reconcile loops and the Stop grace timer; unmount clears them. */
  const timersRef = useRef(new Set<() => void>());
  /** Continuations (by `pendingKey`) that were delivered, so a stale stored copy is not queued again. */
  const doneRef = useRef(new Set<string>());
  /** Continuations (by `pendingKey`) waiting to be re-sent after 409 `continuation_in_progress`. */
  const waitRef = useRef(new Map<string, InProgressWait>());
  const [queueTick, setQueueTick] = useState(0);

  const isCurrent = (epoch: number) => epoch === epochRef.current;

  /**
   * Adds stored items (loaded, or another panel's) to the in-memory queue, or refreshes the queued
   * copy. The stored `held` flag wins: a held copy holds the item here too, and an unheld copy
   * (another panel pressed "Continue") releases it, so its stale "Continue" here goes away.
   */
  const enqueue = useCallback((items: PendingContinuation[]) => {
    let changed = false;
    for (const item of items) {
      const key = pendingKey(item);
      if (doneRef.current.has(key)) continue;
      let released = false;
      if (item.held) heldRef.current.add(key);
      else if (heldRef.current.delete(key)) {
        released = true;
        dispatch({ type: 'dropContinue', setupActionId: item.setup_action_id });
      }
      const queued = queueRef.current.some((q) => pendingKey(q) === key);
      queueRef.current = queued ? queueRef.current.map((q) => (pendingKey(q) === key ? item : q)) : [...queueRef.current, item];
      if (!queued || released) changed = true;
    }
    if (changed) setQueueTick((n) => n + 1);
  }, []);

  /** Forgets a delivered item here, with any "Continue" it shows; another panel's removal arrives the same way. */
  const forget = useCallback((key: string) => {
    const item = queueRef.current.find((q) => pendingKey(q) === key);
    doneRef.current.add(key);
    heldRef.current.delete(key);
    waitRef.current.delete(key);
    queueRef.current = queueRef.current.filter((q) => pendingKey(q) !== key);
    if (item) dispatch({ type: 'dropContinue', setupActionId: item.setup_action_id });
  }, []);

  /** The item was delivered: it leaves the queue and storage (only this item). */
  const dequeue = useCallback(
    (item: PendingContinuation) => {
      forget(pendingKey(item));
      void removePendingContinuation(item).catch(() => {});
    },
    [forget],
  );

  /**
   * The item was not proven delivered: it stays queued and stored, marked held, so it waits for
   * "Continue" here, after a conversation switch and in a reopened panel instead of being re-sent.
   */
  const hold = useCallback((item: PendingContinuation) => {
    const key = pendingKey(item);
    waitRef.current.delete(key);
    if (doneRef.current.has(key) || heldRef.current.has(key)) return;
    heldRef.current.add(key);
    void addPendingContinuation({ ...item, held: true }).catch(() => {});
  }, []);

  /** A timer that unmount clears; resolves after `ms`, or at once when the panel unmounts. */
  const sleep = useCallback(
    (ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          timersRef.current.delete(done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        timersRef.current.add(done);
      }),
    [],
  );

  /**
   * Schedules the next automatic re-send after 409 `continuation_in_progress`. The first wait is the
   * server's `Retry-After` hint when present, then the backoff. False once the retry window (from
   * the first in-progress answer, stored with the item so a reopened panel keeps it) would be over:
   * the item then waits for "Continue".
   */
  const scheduleInProgressRetry = useCallback((item: PendingContinuation, retryAfterSeconds?: number): boolean => {
    const key = pendingKey(item);
    const now = Date.now();
    const queued = queueRef.current.find((q) => pendingKey(q) === key) ?? item;
    const wait = waitRef.current.get(key) ?? { since: queued.in_progress_since ?? now, attempts: 0, at: now };
    if (queued.in_progress_since === undefined && !doneRef.current.has(key)) {
      const stamped = { ...queued, in_progress_since: wait.since };
      queueRef.current = queueRef.current.map((q) => (pendingKey(q) === key ? stamped : q));
      void addPendingContinuation(stamped).catch(() => {});
    }
    const backoff = IN_PROGRESS_RETRY_MS[Math.min(wait.attempts, IN_PROGRESS_RETRY_MS.length - 1)]!;
    const delay = wait.attempts === 0 && retryAfterSeconds ? retryAfterSeconds * 1_000 : backoff;
    if (now + delay - wait.since > IN_PROGRESS_LIMIT_MS) {
      waitRef.current.delete(key);
      return false;
    }
    waitRef.current.set(key, { since: wait.since, attempts: wait.attempts + 1, at: now + delay });
    return true;
  }, []);

  const handleError = useCallback((error: unknown): string => {
    if (isApiError(error)) {
      if (error.status === 401) hooksRef.current.onAuthError(error);
      return error.code;
    }
    return 'runtime_request_failed';
  }, []);

  /**
   * Loads history, run status and open cards while `live()` holds. Resolves to the history, or null
   * when it failed. With `followRun`, a running run starts a reconcile unless one already runs.
   */
  const loadSession = useCallback(
    async (live: () => boolean, sessionKey: string, followRun = true): Promise<HistoryMessage[] | null> => {
      const current = ctxRef.current;
      if (!current) return null;
      try {
        const [history, status, cards] = await Promise.all([
          fetchSessionHistory(current.client, current.workspaceId, sessionKey),
          current.client.status(current.workspaceId, sessionKey).catch(() => ({ running: false, run_id: undefined })),
          current.client.actions(current.workspaceId, { sessionKey, status: 'pending' }).catch(() => []),
        ]);
        if (!live()) return null;
        dispatch({ type: 'history', messages: history, sessionKey });
        dispatch({ type: 'cards', cards });
        baselineRef.current = baselineOf(history);
        if (followRun && status.running && ownerRef.current === null) void reconcileRef.current(sessionKey);
        return history;
      } catch (error) {
        if (!live()) return null;
        dispatch({ type: 'loadFailed', message: handleError(error) });
        return null;
      }
    },
    [handleError],
  );

  /**
   * Waits for a server-side run to finish, then reloads history. Never re-sends anything. It owns
   * the conversation until it ends: a newer loop, a context switch or unmount retires it, and a
   * retired loop writes nothing. Then it settles the unconfirmed turns: a turn the history provably
   * holds is dropped (the server copy shows), any other stays once as `delivery_unconfirmed`, and
   * a continuation that was not proven delivered gets "Continue".
   */
  const reconcile = useCallback(
    async (sessionKey: string, unconfirmed?: Unconfirmed) => {
      const current = ctxRef.current;
      if (!current) return;
      const epoch = epochRef.current;
      const owner = {};
      ownerRef.current = owner;
      const owns = () => ownerRef.current === owner && epoch === epochRef.current && mountedRef.current;
      if (unconfirmed?.text !== undefined) uncheckedRef.current.set(unconfirmed.localId, unconfirmed);
      dispatch({ type: 'reconciling' });
      try {
        let failures = 0;
        for (let poll = 0; owns(); ) {
          if (isOffline()) {
            // Polling cannot succeed offline: pause until the connection is back instead of spinning.
            dispatch({ type: 'reconciling', offline: true });
            await waitForOnline(owns);
            if (!owns()) return;
            dispatch({ type: 'reconciling' });
            continue;
          }
          poll++;
          try {
            const status = await current.client.status(current.workspaceId, sessionKey);
            if (!status.running) break;
            failures = 0;
          } catch (error) {
            if (isApiError(error) && error.status !== 0) break;
            if (isOffline()) continue;
            if (++failures >= RECONCILE_MAX_FAILURES) break;
          }
          // A run still going after the fast polls keeps the conversation busy, polled more slowly.
          await sleep(poll < RECONCILE_FAST_POLLS ? RECONCILE_INTERVAL_MS : RECONCILE_SLOW_INTERVAL_MS);
        }
        if (!owns()) return;
        const history = await loadSession(owns, sessionKey, false);
        if (!owns()) return;
        if (unconfirmed?.continuation) {
          const { localId: id, continuation, code, message } = unconfirmed;
          dispatch({ type: 'restoreTurn', localId: id, continuation, code, message });
        }
        for (const turn of uncheckedRef.current.values()) {
          if (history && holdsTurn(history, turn.text!, turn.baseline)) {
            uncheckedRef.current.delete(turn.localId);
            dispatch({ type: 'dropTurn', localId: turn.localId });
          } else {
            dispatch({ type: 'restoreTurn', localId: turn.localId, text: turn.text, code: 'delivery_unconfirmed', message: turn.message });
          }
        }
        dispatch({ type: 'idle' });
      } finally {
        if (ownerRef.current === owner) ownerRef.current = null;
      }
    },
    [loadSession, sleep],
  );
  useLayoutEffect(() => {
    reconcileRef.current = reconcile;
  }, [reconcile]);

  const scopeRef = useRef<{ client?: DeweeClient; workspaceId?: string; agentKey?: string } | null>(null);
  useEffect(() => {
    const scope = scopeRef.current;
    const sameScope = scope !== null && scope.client === ctx?.client && scope.workspaceId === ctx?.workspaceId && scope.agentKey === ctx?.agentKey;
    scopeRef.current = { client: ctx?.client, workspaceId: ctx?.workspaceId, agentKey: ctx?.agentKey };
    // A session key adopted from `chat.started` comes back through the props; the conversation
    // on screen already is that session, so it must not be reset.
    if (sameScope && ctx?.sessionKey !== undefined && ctx.sessionKey === stateRef.current.sessionKey) return;
    epochRef.current += 1;
    const epoch = epochRef.current;
    streamRef.current?.abort();
    streamRef.current = null;
    ownerRef.current = null;
    baselineRef.current = null;
    uncheckedRef.current = new Map();
    // Continuations of other sessions stay queued; reopening their session sends them (held ones
    // stay held and show "Continue" there).
    stateRef.current = initialChatState(ctx?.sessionKey);
    dispatch({ type: 'reset', sessionKey: ctx?.sessionKey });
    if (ctx?.sessionKey) void loadSession(() => isCurrent(epoch) && mountedRef.current, ctx.sessionKey);
    void loadPendingContinuations().then((items) => enqueue(items), () => {});
  }, [ctx?.client, ctx?.workspaceId, ctx?.agentKey, ctx?.sessionKey, loadSession, enqueue]);

  // Items another panel adds or delivers show up here too, so neither panel loses or repeats them.
  useEffect(() => watchPendingContinuations({ added: (item) => enqueue([item]), removed: forget }), [enqueue, forget]);

  const abortOnServer = useCallback(
    async (sessionKey: string, runId?: string) => {
      const current = ctxRef.current;
      if (!current) return;
      try {
        await current.client.abort(current.workspaceId, { session_key: sessionKey, ...(runId ? { run_id: runId } : {}), agent_key: current.agentKey });
      } catch (error) {
        handleError(error);
      }
    },
    [handleError],
  );

  /** Stop was pressed before the server named the run. */
  const stopRequestedRef = useRef(false);
  /** The server accepted the current run (`chat.started` arrived, with or without a run id). */
  const startedRef = useRef(false);

  /**
   * Starts one stream: a user message (`text`) or a queued continuation (`item`). Returns false,
   * synchronously, when it is refused because another stream or reconcile already runs; nothing is
   * sent then. `streamRef` is set synchronously, so two calls in the same tick cannot both send.
   */
  const runStream = useCallback(
    (text?: string, item?: PendingContinuation): boolean => {
      const current = ctxRef.current;
      if (!current || streamRef.current || ownerRef.current || stateRef.current.phase === 'streaming' || stateRef.current.phase === 'reconciling') return false;
      const epoch = epochRef.current;
      // A conversation switch and unmount end the stream the same way: no state is written and a
      // continuation is not held, so it is sent again when its session is shown (here or in a reopened panel).
      const live = () => isCurrent(epoch) && mountedRef.current;
      const controller = new AbortController();
      streamRef.current = controller;
      stopRequestedRef.current = false;
      startedRef.current = false;
      // Taken at send time: a later reconcile compares the server history against it.
      const baseline = baselineRef.current;
      const turnId = localId();
      const continuation: Continuation | undefined = item ? { setup_action_id: item.setup_action_id, session_key: item.session_key, agent_key: item.agent_key } : undefined;
      const body = continuation ?? { message: text };
      dispatch({ type: 'send', text, localId: turnId });
      void (async () => {
        let accepted = false;
        // Any frame means the server answered 200, so the turn was taken.
        let responded = false;
        // Tracked here, not from state: the reducer's phase only updates on the next commit.
        let terminal = false;
        // The continuation provably reached the agent's session and left the queue.
        let settled = false;
        const settle = () => {
          if (!item || settled) return;
          settled = true;
          dequeue(item);
        };
        try {
          const sessionKey = continuation?.session_key ?? stateRef.current.sessionKey;
          const stream = current.client.streamChat(
            current.workspaceId,
            { agent_key: current.agentKey, ...body, ...(sessionKey ? { session_key: sessionKey } : {}) },
            controller.signal,
          );
          for await (const event of stream) {
            responded = true;
            // Only these frames prove the agent got the card result. Any earlier frame does not: the
            // Gateway releases the lease when the run fails before the result is saved.
            if (event.type === 'message.completed' || (event.type === 'chat.error' && event.code === 'setup_result_delivered')) settle();
            if (!live()) return;
            if (event.type === 'message.completed' || event.type === 'chat.error' || event.type === 'chat.stopped') terminal = true;
            // Recorded before anything awaits, so a session key adopted by the parent meets a
            // conversation that already holds it and is not reset.
            dispatch({ type: 'event', event });
            if (item && !settled && (event.type === 'chat.error' || event.type === 'chat.stopped')) {
              // The run ended without delivering it: it waits for "Continue", which the Gateway
              // answers `continuation_sent` if it was delivered after all.
              hold(item);
              dispatch({ type: 'offerContinue', localId: turnId, continuation: continuation!, code: 'continuation_stopped', message: 'Stopped' });
            }
            if (event.type === 'chat.started') {
              accepted = true;
              startedRef.current = true;
              if (text !== undefined) {
                // The server now holds one more user turn than the baseline; a new chat holds only this one.
                const known = stateRef.current.sessionKey ? baselineRef.current : { position: -1, confirmed: 0 };
                baselineRef.current = known ? { ...known, confirmed: known.confirmed + 1 } : null;
              }
              if (event.sessionKey && event.sessionKey !== stateRef.current.sessionKey) {
                stateRef.current = { ...stateRef.current, sessionKey: event.sessionKey };
                hooksRef.current.onSessionKey(event.sessionKey);
              }
              if (stopRequestedRef.current) {
                stopRequestedRef.current = false;
                const key = event.sessionKey ?? stateRef.current.sessionKey;
                if (key) await abortOnServer(key, event.runId);
                if (!live()) return;
                controller.abort();
              }
            }
          }
          if (live() && !terminal) {
            // The stream closed without a terminal frame: the run may still be going on the server.
            if (item && !settled) {
              // Not proven delivered: held, and the reconcile offers "Continue" once the run ends.
              hold(item);
              const message = 'The stream ended early';
              dispatch({ type: 'streamFailed', code: 'continuation_unconfirmed', message, reconcile: true, local: true });
              void reconcile(item.session_key, { localId: turnId, continuation, code: 'continuation_unconfirmed', message, baseline });
            } else if (stateRef.current.sessionKey) void reconcile(stateRef.current.sessionKey);
            else dispatch({ type: 'streamFailed', code: 'delivery_unconfirmed', message: 'The stream ended early', reconcile: false, recover: 'sessions' });
          }
        } catch (error) {
          if (!live()) return;
          if (error instanceof DOMException && error.name === 'AbortError') {
            if (item && !settled) {
              // Stopped before the agent provably got it: it stays queued for "Continue" (the Gateway
              // delivers it at most once).
              hold(item);
              dispatch({ type: 'streamFailed', code: 'continuation_stopped', message: 'Stopped', reconcile: false, retryContinuation: continuation, local: true });
              return;
            }
            dispatch({ type: 'event', event: { type: 'chat.stopped' } });
            return;
          }
          const apiError = isApiError(error) ? error : null;
          // A programming fault is logged (the error only, never the request) and handled as a failure.
          if (!apiError || apiError.cause !== undefined) console.error('Chat stream failed', apiError?.cause ?? error);
          const code = handleError(error);
          const message = apiError ? apiError.message : 'Request failed';
          const sessionKey = stateRef.current.sessionKey ?? continuation?.session_key;
          if (item && !settled && apiError?.status === 409 && code === 'continuation_sent') {
            // Delivered earlier (by this or another panel): a silent success, so the turn goes away
            // and the conversation reloads to show the agent's reply.
            settle();
            dispatch({ type: 'dropTurn', localId: turnId });
            dispatch({ type: 'idle' });
            void loadSession(() => isCurrent(epoch) && mountedRef.current, item.session_key);
            return;
          }
          if (item && !settled && apiError?.status === 409 && code === 'continuation_in_progress') {
            // Another request holds the send lease; it may still fail and release it, so this is not
            // delivery. The item stays queued and is sent again after a backoff, then waits for "Continue".
            if (scheduleInProgressRetry(item, apiError.retryAfterSeconds)) {
              dispatch({ type: 'dropTurn', localId: turnId });
              dispatch({ type: 'idle' });
            } else {
              hold(item);
              dispatch({ type: 'streamFailed', code, message, reconcile: false, retryContinuation: continuation, local: true });
            }
            return;
          }
          const fixable = apiError?.status === 403 && FIXABLE_REFUSAL_CODES.has(code);
          if (item && !settled && !responded && apiError && DEAD_CONTINUATION_STATUSES.has(apiError.status) && !fixable) {
            // The card or its continuation is invalid, gone or not allowed: sending it again can never
            // succeed, so it leaves the queue. The person is told once, with no "Continue", that the
            // agent did not get the card's result; a 400 is a client bug, so the refusal is logged (no payload).
            console.warn('Card continuation refused', { status: apiError.status, code });
            settle();
            dispatch({ type: 'streamFailed', code: 'continuation_refused', message, reconcile: false });
            return;
          }
          if (item && !settled) hold(item);
          // The server took the turn: it answered 200 or named the run (a continuation: the agent got it).
          const taken = item ? settled : accepted || responded || Boolean(apiError?.afterResponse);
          if (notReceived(error, responded)) {
            // Nothing reached the server (or it refused the turn), so sending it again cannot start a
            // second run. A continuation stays queued for "Continue", whatever the refusal's code.
            dispatch({
              type: 'streamFailed',
              code,
              message,
              reconcile: false,
              retryText: text,
              retryContinuation: continuation,
              retryAfterSeconds: apiError?.retryAfterSeconds,
              local: Boolean(continuation),
            });
          } else if (!sessionKey) {
            // A new chat that may have created a session: point the person to the conversation list.
            dispatch({ type: 'streamFailed', code: 'delivery_unconfirmed', message, reconcile: false, recover: 'sessions' });
          } else if (taken) {
            dispatch({ type: 'streamFailed', code, message, reconcile: true, retryAfterSeconds: apiError?.retryAfterSeconds });
            void reconcile(sessionKey);
          } else {
            // Uncertain in a known session: the history settles it, and it never offers "Send again".
            // A continuation (a drop after the response included) gets "Continue" once the run ends.
            dispatch({ type: 'streamFailed', code, message, reconcile: true, local: true });
            void reconcile(sessionKey, { localId: turnId, text, continuation, code, message, baseline });
          }
        } finally {
          if (streamRef.current === controller) {
            streamRef.current = null;
            setStreamsEnded((n) => n + 1);
          }
        }
      })();
      return true;
    },
    [handleError, reconcile, abortOnServer, dequeue, hold, loadSession, scheduleInProgressRetry],
  );

  const send = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      return trimmed ? runStream(trimmed) : false;
    },
    [runStream],
  );

  const continueWith = useCallback(
    async (continuation: Continuation, scope?: ContinuationScope) => {
      const profileId = scope?.profileId ?? ctxRef.current?.profileId;
      const workspaceId = scope?.workspaceId ?? ctxRef.current?.workspaceId;
      if (!profileId || !workspaceId) return;
      const item: PendingContinuation = {
        session_key: continuation.session_key,
        agent_key: continuation.agent_key,
        setup_action_id: continuation.setup_action_id,
        profile_id: profileId,
        workspace_id: workspaceId,
      };
      const key = pendingKey(item);
      if (doneRef.current.has(key)) return;
      heldRef.current.delete(key);
      waitRef.current.delete(key);
      // Stored again without the held mark (it may be queued already), so it is sent automatically.
      queueRef.current = [...queueRef.current.filter((q) => pendingKey(q) !== key), item];
      void addPendingContinuation(item).catch(() => {});
      setQueueTick((n) => n + 1);
    },
    [],
  );

  // Sends the next queued continuation of the conversation on screen once it is idle. One at a
  // time: the next waits until this stream ends. Other sessions' continuations wait for theirs.
  // One answered `continuation_in_progress` waits for its retry time, and only while shown and idle.
  useEffect(() => {
    if (state.phase !== 'idle') return;
    const current = ctxRef.current;
    const sessionKey = stateRef.current.sessionKey;
    if (!current || !sessionKey) return;
    const shown = queueRef.current.filter(
      (q) => q.profile_id === current.profileId && q.workspace_id === current.workspaceId && q.agent_key === current.agentKey && q.session_key === sessionKey,
    );
    // A held item of this session (held before a switch or in an earlier panel) shows "Continue" once.
    for (const q of shown) {
      if (!heldRef.current.has(pendingKey(q)) || stateRef.current.messages.some((m) => m.retryContinuation?.setup_action_id === q.setup_action_id)) continue;
      const continuation = { session_key: q.session_key, agent_key: q.agent_key, setup_action_id: q.setup_action_id };
      dispatch({ type: 'restoreTurn', localId: localId(), continuation, code: 'continuation_unconfirmed', message: 'Not delivered yet' });
    }
    const mine = shown.filter((q) => !heldRef.current.has(pendingKey(q)));
    const now = Date.now();
    const dueAt = (q: PendingContinuation) => waitRef.current.get(pendingKey(q))?.at ?? 0;
    const next = mine.find((q) => dueAt(q) <= now);
    if (next) {
      runStream(undefined, next);
      return;
    }
    if (!mine.length) return;
    const timer = setTimeout(() => setQueueTick((n) => n + 1), Math.min(...mine.map(dueAt)) - now);
    return () => clearTimeout(timer);
  }, [state.phase, state.sessionKey, streamsEnded, queueTick, runStream]);

  const stop = useCallback(async () => {
    const { sessionKey, runId, phase } = stateRef.current;
    if (phase === 'streaming' && !startedRef.current) {
      // The server has not reported the run yet: stop it as soon as `chat.started` names it,
      // and give up waiting after a short while so the button always works.
      stopRequestedRef.current = true;
      const controller = streamRef.current;
      void sleep(STOP_GRACE_MS).then(() => {
        if (stopRequestedRef.current && streamRef.current === controller) {
          stopRequestedRef.current = false;
          controller?.abort();
        }
      });
      return;
    }
    if (sessionKey) await abortOnServer(sessionKey, runId);
    streamRef.current?.abort();
  }, [abortOnServer, sleep]);

  const loadOlder = useCallback(async () => dispatch({ type: 'older' }), []);

  const reload = useCallback(async () => {
    const sessionKey = stateRef.current.sessionKey;
    if (!sessionKey || ownerRef.current || streamRef.current) return;
    if (uncheckedRef.current.size) {
      await reconcile(sessionKey);
      return;
    }
    const epoch = epochRef.current;
    await loadSession(() => isCurrent(epoch) && mountedRef.current, sessionKey);
  }, [loadSession, reconcile]);

  const retry = useCallback(
    async (message: ChatMessage) => {
      const { phase } = stateRef.current;
      if (streamRef.current || ownerRef.current || phase === 'streaming' || phase === 'reconciling') return;
      // The failed copy goes away: the turn is sent again as a new one.
      if (message.retryContinuation) {
        dispatch({ type: 'dropTurn', localId: turnIdOf(message) });
        await continueWith(message.retryContinuation);
      } else if (message.retryText) {
        dispatch({ type: 'dropTurn', localId: turnIdOf(message) });
        send(message.retryText);
      }
    },
    [send, continueWith],
  );

  const updateCard = useCallback((card: UiActionCard) => dispatch({ type: 'card', card }), []);

  useEffect(() => {
    mountedRef.current = true;
    const timers = timersRef.current;
    return () => {
      mountedRef.current = false;
      streamRef.current?.abort();
      // Ends pending sleeps now (their timers are cleared); the loops waiting on them see the unmount and stop.
      for (const done of [...timers]) done();
    };
  }, []);

  return { state, send, continueWith, stop, loadOlder, reload, retry, updateCard };
}
