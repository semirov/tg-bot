import { performance } from 'perf_hooks';

/**
 * Lightweight, bounded publication-activity tracker (TGB-121).
 *
 * The memory watchdog must not end the process silently while a channel
 * publication is in flight, so every exit line carries the current publication
 * state. Only timestamps, an outcome and the suggestion-card id are kept — no
 * captions and no user ids — and the state is a fixed-size record, so it cannot
 * grow. The card id is there on purpose: a restart during a publish can leave a
 * burned claim behind (claims are fail-closed since TGB-117) and the operator
 * needs the card to release it.
 */
export type PublishOutcome = 'ok' | 'error';

/** Snapshot of the publication state. */
export interface PublishActivityState {
  /** Monotonic ms when the current publication started, `null` when idle. */
  inFlightSinceMs: number | null;
  /** Suggestion-card id (`requestChannelMessageId`) of the current publish. */
  card: number | null;
  /** Monotonic ms when the last publication settled, `null` if none yet. */
  lastFinishedAtMs: number | null;
  /** Outcome of the last settled publication. */
  lastOutcome: PublishOutcome | null;
}

const state: PublishActivityState = {
  inFlightSinceMs: null,
  card: null,
  lastFinishedAtMs: null,
  lastOutcome: null,
};

/** Marks a publication as started, remembering the card it publishes. */
export function markPublishStart(card?: number | null, nowMs: number = performance.now()): void {
  state.inFlightSinceMs = nowMs;
  state.card = card ?? null;
}

/** Marks the current publication as settled and records its outcome. */
export function markPublishEnd(ok: boolean, nowMs: number = performance.now()): void {
  state.inFlightSinceMs = null;
  state.lastFinishedAtMs = nowMs;
  state.lastOutcome = ok ? 'ok' : 'error';
}

/** `true` while a channel publication (button or cron) is in flight. */
export function isPublishInFlight(): boolean {
  return state.inFlightSinceMs !== null;
}

/** Current state (copy, so callers cannot mutate the tracker). */
export function publishActivityState(): PublishActivityState {
  return { ...state };
}

/**
 * Runs one publication under the activity marker and always clears it.
 *
 * The marker is set before `run` and cleared in `finally`, so a thrown or
 * rejected publish never leaves the watchdog thinking a send is still running.
 */
export async function trackPublishActivity<T>(
  card: number | null | undefined,
  run: () => Promise<T>
): Promise<T> {
  markPublishStart(card);
  let ok = false;
  try {
    const result = await run();
    ok = true;
    return result;
  } finally {
    markPublishEnd(ok);
  }
}

/**
 * One-line description for logs: in-flight age and card, or the last outcome.
 * Safe for logs — timestamps and one card id, no captions or user data.
 */
export function describePublishActivity(nowMs: number = performance.now()): string {
  if (state.inFlightSinceMs !== null) {
    const inFlight = Math.round(nowMs - state.inFlightSinceMs);
    const card = state.card === null ? '' : ` card=${state.card}`;
    const previous =
      state.lastFinishedAtMs === null
        ? ''
        : ` last_outcome=${state.lastOutcome} last_finished_ago_ms=${Math.round(
            nowMs - state.lastFinishedAtMs
          )}`;
    return `in_flight_for_ms=${inFlight}${card}${previous}`;
  }
  if (state.lastFinishedAtMs === null) {
    return 'idle';
  }
  return `idle last_outcome=${state.lastOutcome} last_finished_ago_ms=${Math.round(
    nowMs - state.lastFinishedAtMs
  )}`;
}

/** Clears the tracker (tests). */
export function resetPublishActivity(): void {
  state.inFlightSinceMs = null;
  state.card = null;
  state.lastFinishedAtMs = null;
  state.lastOutcome = null;
}
