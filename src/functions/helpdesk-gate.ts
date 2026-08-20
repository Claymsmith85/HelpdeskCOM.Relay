// src/functions/helpdesk-gate.ts
// Global Helpdesk throttle gate: when Helpdesk answers 429, ALL Helpdesk traffic pauses until the
// Retry-After deadline instead of every caller discovering the throttle for itself.
//
// The problem this solves. `http-retry.ts` backs off ONE request; it holds no state another caller
// can see, and `rate-limit.ts` paces steady-state traffic but knows nothing about what the server
// just said. So a throttled Helpdesk used to be re-discovered independently by every queue item,
// every webhook, and every retry — each one spending a fresh request to earn its own 429 and
// deepening the throttle it was reacting to. One shared deadline turns that stampede into a wait.
//
// Two layers, because they answer different questions:
//   - PROCESS-LOCAL deadline (this module's singleton) — authoritative, free to read, and the thing
//     every request actually waits on. Fixes the common case: a drain and a webhook in one worker,
//     and the back-to-back continuation invocations the drain queues for itself.
//   - SHARED deadline (a blob) — read once per invocation and written when this process is
//     penalized, so a second instance inherits the pause instead of rediscovering it. Deliberately
//     NOT read per request: the round-trip would cost more than it saves for a condition this rare,
//     and being a few seconds stale only means one extra 429 on another instance.
//
// The gate is Helpdesk-scoped ON PURPOSE. Graph and Storage keep running during a cooldown: their
// work (attachment uploads, mailbox moves, claim blobs) is unrelated to Helpdesk's rate limit, and
// freezing it would make the drain more likely to burn its 10-minute functionTimeout mid-message,
// not less.
//
// Callers with somewhere to put the work back defer instead of waiting — see shouldDeferForGate.
import { AxiosError, AxiosInstance } from "axios";
import { parseRetryAfter } from "./http-retry";
import { envFlag, envPositiveNumber } from "./env";
import { buildStorageClient, readBlobText, writeBlobText } from "./storage-client";

// Container is shared with the other relay state blobs (claims, alert throttles) — same storage
// account and UAMI as AzureWebJobsStorage, so a new caller needs no new RBAC.
const DEFAULT_GATE_CONTAINER = "relay-state";
const GATE_BLOB_NAME = "helpdesk-throttle-gate";

// Cooldown applied when a 429 carries no Retry-After header. Long enough to actually clear a
// per-second/per-minute window, short enough that a spurious 429 costs little.
const DEFAULT_COOLDOWN_MS = 10_000;
// Ceiling on any single cooldown, so a bogus or hostile Retry-After can't park the relay for hours.
const DEFAULT_MAX_COOLDOWN_MS = 300_000;
// How long a single request waits in place before giving up on the gate and dispatching anyway.
// Callers that can defer (process-mail, sync-teams) check the gate up front and never get here with
// a long cooldown; this is the backstop for everyone else.
const DEFAULT_MAX_WAIT_MS = 30_000;
// Remaining cooldown above which a deferrable caller should put the work back rather than sleep.
const DEFAULT_DEFER_ABOVE_MS = 30_000;
// The webhook's budget: it must answer Helpdesk quickly or the delivery is repeated (and the email
// with it), so it waits only briefly before dispatching regardless.
const DEFAULT_WEBHOOK_MAX_WAIT_MS = 5_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type HelpdeskGateOptions = {
  // Test seams (production omits both) — the http-retry.ts / drain-lock.ts convention.
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type HelpdeskGate = {
  /** Milliseconds until the cooldown clears; 0 when there is none. */
  remainingMs(): number;
  /** The current cooldown deadline as an epoch millisecond value (0 = no cooldown). */
  deadline(): number;
  /**
   * Record that Helpdesk rejected a request with 429. `retryAfterMs` is the parsed Retry-After when
   * the server supplied one. Only ever extends the deadline — a shorter concurrent penalty must not
   * shorten a longer one already in force.
   */
  penalize(retryAfterMs: number | null, opts?: { defaultMs?: number; maxMs?: number }): number;
  /** Adopt a deadline observed elsewhere (the shared blob). Extends only, never shortens. */
  adopt(deadlineMs: number): void;
  /**
   * Wait for the cooldown to clear, up to `maxWaitMs`. Returns the milliseconds still remaining —
   * 0 means the gate is clear, non-zero means the caller waited its whole budget and should decide
   * for itself whether to proceed.
   */
  waitUntilClear(maxWaitMs: number): Promise<number>;
  /** True when this process has been penalized since the last publish (see publishGate). */
  isDirty(): boolean;
  /** Clear the dirty flag; called by publishGate once the deadline has been written. */
  markPublished(): void;
  /** Test helper — drop all state. */
  reset(): void;
};

export function createHelpdeskGate(opts: HelpdeskGateOptions = {}): HelpdeskGate {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  let deadlineAt = 0;
  let dirty = false;

  const remaining = () => Math.max(0, deadlineAt - now());

  return {
    remainingMs: remaining,
    deadline: () => deadlineAt,

    penalize(retryAfterMs, penaltyOpts = {}) {
      const fallback = penaltyOpts.defaultMs ?? DEFAULT_COOLDOWN_MS;
      const max = penaltyOpts.maxMs ?? DEFAULT_MAX_COOLDOWN_MS;
      // A Retry-After of 0 is a real answer ("try again now"), so only null/undefined falls back.
      const requested = retryAfterMs === null ? fallback : retryAfterMs;
      const capped = Math.min(Math.max(0, requested), max);
      const candidate = now() + capped;
      if (candidate > deadlineAt) {
        deadlineAt = candidate;
        dirty = true;
      }
      return deadlineAt;
    },

    adopt(deadlineMs) {
      if (Number.isFinite(deadlineMs) && deadlineMs > deadlineAt) deadlineAt = deadlineMs;
    },

    async waitUntilClear(maxWaitMs) {
      const outstanding = remaining();
      if (outstanding <= 0) return 0;
      // One sleep, not a poll loop: the deadline only ever moves later, and a request that wakes to
      // find it extended is handled by the caller's own budget rather than by spinning here.
      await sleep(Math.min(outstanding, Math.max(0, maxWaitMs)));
      return remaining();
    },

    isDirty: () => dirty,
    markPublished() {
      dirty = false;
    },
    reset() {
      deadlineAt = 0;
      dirty = false;
    },
  };
}

/** The process-wide gate every Helpdesk client shares. */
export const helpdeskGate = createHelpdeskGate();

// #region env

/** Master escape hatch (`HELPDESK_GATE_ENABLED=false`), read per invocation. */
export function gateEnabled(): boolean {
  return envFlag(process.env.HELPDESK_GATE_ENABLED, true);
}

/** Whether the cooldown deadline is shared across instances via blob storage. */
export function gateSharedEnabled(): boolean {
  return envFlag(process.env.HELPDESK_GATE_SHARED, true);
}

export function gateContainer(): string {
  return process.env.HELPDESK_GATE_CONTAINER ?? DEFAULT_GATE_CONTAINER;
}

export function gateCooldownOptions(): { defaultMs: number; maxMs: number } {
  return {
    defaultMs: envPositiveNumber(
      process.env.HELPDESK_GATE_DEFAULT_COOLDOWN_MS,
      DEFAULT_COOLDOWN_MS,
      { integer: true }
    ),
    maxMs: envPositiveNumber(process.env.HELPDESK_GATE_MAX_COOLDOWN_MS, DEFAULT_MAX_COOLDOWN_MS, {
      integer: true,
    }),
  };
}

export function gateMaxWaitMs(): number {
  return envPositiveNumber(process.env.HELPDESK_GATE_MAX_WAIT_MS, DEFAULT_MAX_WAIT_MS, {
    integer: true,
  });
}

export function gateDeferAboveMs(): number {
  return envPositiveNumber(process.env.HELPDESK_GATE_DEFER_ABOVE_MS, DEFAULT_DEFER_ABOVE_MS, {
    integer: true,
  });
}

/**
 * The webhook's own (much smaller) wait budget. It cannot defer — Helpdesk redelivers a slow
 * webhook and the sends are not idempotent — so it cooperates briefly and then dispatches anyway.
 */
export function webhookGateMaxWaitMs(): number {
  return envPositiveNumber(
    process.env.HELPDESK_GATE_WEBHOOK_MAX_WAIT_MS,
    DEFAULT_WEBHOOK_MAX_WAIT_MS,
    { integer: true }
  );
}

// #endregion

// #region axios wiring

/**
 * Make every request through this client wait on the gate, and every 429 extend it.
 *
 * Registration order matters and is set by the caller (helpdesk-client.ts): the gate's REQUEST
 * interceptor must run before the rate limiter's, or a request would reserve a dispatch slot, sleep
 * out the cooldown holding it, and then fire the instant the gate opens together with every other
 * waiter — a thundering herd at exactly the moment Helpdesk is least able to take one. Waiting
 * first and reserving after means the limiter re-paces the released queue.
 */
export function attachHelpdeskGateInterceptor(
  client: AxiosInstance,
  gate: HelpdeskGate,
  opts: {
    maxWaitMs: number;
    cooldown: { defaultMs: number; maxMs: number };
    onWaited?: (waitedForMs: number, stillGatedMs: number) => void;
    onPenalized?: (cooldownMs: number, retryAfterMs: number | null) => void;
  }
): AxiosInstance {
  client.interceptors.request.use(async (config) => {
    const before = gate.remainingMs();
    if (before > 0) {
      const after = await gate.waitUntilClear(opts.maxWaitMs);
      opts.onWaited?.(before - after, after);
    }
    return config;
  });

  client.interceptors.response.use(undefined, (error: AxiosError) => {
    if (error.response?.status === 429) {
      const retryAfterMs = parseRetryAfter(error.response?.headers?.["retry-after"]);
      gate.penalize(retryAfterMs, opts.cooldown);
      // Read the remainder back off the gate rather than recomputing from Date.now(): the gate owns
      // the clock (and has an injected one under test).
      opts.onPenalized?.(gate.remainingMs(), retryAfterMs);
    }
    throw error;
  });

  return client;
}

// #endregion

// #region shared (cross-instance) deadline

type GateBlobBody = { deadlineAt?: number };

async function gateStorageClient(): Promise<AxiosInstance> {
  return buildStorageClient({
    timeoutMs: envPositiveNumber(process.env.HELPDESK_GATE_HTTP_TIMEOUT_MS, 15_000, {
      integer: true,
    }),
    errorPrefix: "helpdesk-gate",
  });
}

/**
 * Read the shared deadline and adopt it locally. Called ONCE per invocation by callers that can act
 * on it, so an instance inherits a pause another instance is already serving.
 *
 * Best-effort by design: this is an optimization over the process-local gate, never a correctness
 * requirement, so a storage failure logs and leaves the local gate untouched. Failing closed here
 * would let a storage blip halt Helpdesk traffic entirely — the opposite of the availability posture
 * the reply/mail claims already take.
 */
export async function syncGateFromStore(
  gate: HelpdeskGate = helpdeskGate,
  log?: (message: string, data?: any) => void,
  client?: AxiosInstance
): Promise<void> {
  if (!gateEnabled() || !gateSharedEnabled()) return;
  try {
    const storage = client ?? (await gateStorageClient());
    const raw = await readBlobText(storage, gateContainer(), GATE_BLOB_NAME);
    if (!raw) return;
    const parsed = JSON.parse(raw) as GateBlobBody;
    const deadlineAt = Number(parsed?.deadlineAt);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) return;
    gate.adopt(deadlineAt);
    log?.("Helpdesk gate: adopted shared cooldown", {
      remainingMs: gate.remainingMs(),
    });
  } catch (e) {
    log?.("Helpdesk gate: shared cooldown read failed (using local state)", {
      error: (e as Error)?.message ?? String(e),
    });
  }
}

/**
 * Publish this process's deadline so other instances can adopt it. No-op unless the gate was
 * penalized since the last publish. Best-effort for the same reason as the read.
 */
export async function publishGate(
  gate: HelpdeskGate = helpdeskGate,
  log?: (message: string, data?: any) => void,
  client?: AxiosInstance
): Promise<void> {
  if (!gateEnabled() || !gateSharedEnabled() || !gate.isDirty()) return;
  const deadlineAt = gate.deadline();
  try {
    const storage = client ?? (await gateStorageClient());
    await writeBlobText(
      storage,
      gateContainer(),
      GATE_BLOB_NAME,
      JSON.stringify({ deadlineAt } satisfies GateBlobBody)
    );
    gate.markPublished();
    log?.("Helpdesk gate: published cooldown", { deadlineAt });
  } catch (e) {
    log?.("Helpdesk gate: cooldown publish failed (local gate still applies)", {
      error: (e as Error)?.message ?? String(e),
    });
  }
}

export const GATE_BLOB = GATE_BLOB_NAME;

// #endregion

/**
 * Entry point for a caller that can put its work back: wait out a short cooldown in place, and
 * report a long one so the caller defers. Returns 0 when it is safe to proceed, else the
 * milliseconds still remaining.
 *
 * The wait is what paces the deferral. A Storage Queue output binding cannot set a visibility
 * delay, so a re-enqueued item becomes visible immediately — re-enqueueing the instant a cooldown
 * is seen would spin the item against the gate for the whole cooldown. Spending the pacing budget
 * here first bounds that to one re-enqueue per window, exactly as acquireDrainLock's bounded wait
 * paces the lock-contended defer. If the cooldown clears inside the budget the caller simply
 * carries on and nothing is re-queued at all.
 */
export async function waitOrDefer(gate: HelpdeskGate = helpdeskGate): Promise<number> {
  if (!gateEnabled() || gate.remainingMs() <= 0) return 0;
  return gate.waitUntilClear(gateDeferAboveMs());
}

/**
 * Has a cooldown opened that is too long to sit out mid-run? Used between work items, where the
 * caller has already started and wants to stop cleanly rather than wait.
 */
export function gateExceedsDeferBudget(gate: HelpdeskGate = helpdeskGate): boolean {
  return gateEnabled() && gate.remainingMs() > gateDeferAboveMs();
}
