// src/functions/drain-lock.ts
// Per-mailbox distributed lock for the inbound drain (process-mail).
//
// WHY THIS EXISTS. process-mail's correctness rests on three guarantees (see CLAUDE.md invariant
// #4). Two already hold without any locking: at-least-once delivery (the whole-inbox drain +
// sweep-inbox re-list everything) and idempotency-against-duplicate-NOTIFICATIONS (the
// move-to-processed step makes a duplicate getMessage 404). The missing one is MUTUAL EXCLUSION
// under cross-instance concurrency: on a multi-instance plan, two notifications for two emails that
// arrive close together produce two queue items that two different instances dequeue and drain at
// once; both re-list the same inbox and both clear the non-atomic listTicketsByRequester ->
// createTicket for a message neither has moved yet, so that message gets two tickets and two acks.
// host.json batchSize:1 only serializes WITHIN one instance, so it cannot close this window.
//
// THE FIX. Serialize drains PER MAILBOX with an Azure Storage blob lease — the same primitive the
// Functions runtime uses for its own singleton locks. Only one instance holds a given mailbox's
// lease at a time, so its drain never overlaps another drain of the same mailbox. The lock is keyed
// by mailbox (not globally) so different mailboxes still drain concurrently on different instances —
// scale-out is preserved; only colliding work is serialized.
//
// WHY REST (not @azure/storage-blob). The codebase talks to Azure over raw axios (see graph-mail.ts
// / sharepoint.ts) and avoids the heavy Azure SDKs; the blob lease API is three one-line PUTs, so
// we reuse axios + @azure/identity (both already dependencies) rather than add a new one. Auth is
// the SAME user-assigned managed identity the runtime already uses for identity-based
// AzureWebJobsStorage (so the storage RBAC is already in place).
//
// FAILURE MODES (all chosen to fail SAFE — never silently drop exclusivity):
//   - Contention (lease already held): we poll for a bounded window, then return null so the caller
//     defers (re-enqueues) instead of draining unlocked.
//   - A storage error during acquire THROWS — the caller lets the drain fail so the queue retries,
//     rather than draining without the lock and risking a duplicate. A persistent error stalls mail
//     (alertable via the poison queue) but never duplicates it. The DRAIN_LOCK_ENABLED escape hatch
//     reverts to the old unlocked behavior if the lock ever misbehaves in production.
//   - Crash mid-drain: the renewal timer dies with the process, so the lease expires on its own
//     within DRAIN_LOCK_LEASE_SECONDS and the next trigger re-acquires. Nothing deadlocks.
import { AxiosError, AxiosInstance } from "axios";
import { randomUUID } from "node:crypto";
import { buildStorageClient as buildSharedStorageClient } from "./storage-client";
import { envPositiveNumber } from "./env";

// #region Configuration (read once at load)

// Escape hatch: set DRAIN_LOCK_ENABLED=false to revert to the pre-lock behavior (drain with no
// cross-instance mutual exclusion) without a redeploy, should the lock ever misbehave.
const DRAIN_LOCK_ENABLED = (process.env.DRAIN_LOCK_ENABLED ?? "true").toLowerCase() !== "false";

// Blob container that holds the per-mailbox lock blobs (one tiny 0-byte blob per mailbox). Lives in
// the same account as AzureWebJobsStorage, which the UAMI can already write to.
const LOCK_CONTAINER = process.env.DRAIN_LOCK_CONTAINER ?? "drain-locks";

// Lease duration. Azure caps a fixed lease at 60s; we renew well before expiry. A crash leaves the
// lease held for at most this long before it auto-expires and another instance can take over.
const LEASE_SECONDS = Math.min(
  60,
  Math.max(15, envPositiveNumber(process.env.DRAIN_LOCK_LEASE_SECONDS, 60, { integer: true }))
);
// Renew interval — comfortably shorter than the lease so a single transient renew failure (the
// axios retry handles most) doesn't let the lease lapse mid-drain.
const RENEW_MS = envPositiveNumber(process.env.DRAIN_LOCK_RENEW_MS, 25_000, { integer: true });
// How long to wait for a contended lease before giving up and deferring. This is also what paces
// the caller's re-enqueue cadence under contention (the wait is spent here, so a deferred item is
// re-enqueued at most every ~ACQUIRE_WAIT_MS rather than in a busy loop). Kept well under the
// 10-min functionTimeout so a waiting drain never overruns.
const ACQUIRE_WAIT_MS = envPositiveNumber(process.env.DRAIN_LOCK_ACQUIRE_WAIT_MS, 30_000, { integer: true });
const ACQUIRE_POLL_MS = envPositiveNumber(process.env.DRAIN_LOCK_ACQUIRE_POLL_MS, 3_000, { integer: true });
const HTTP_TIMEOUT_MS = envPositiveNumber(process.env.DRAIN_LOCK_HTTP_TIMEOUT_MS, 30_000, { integer: true });

// #endregion

// #region Types

export type DrainLock = {
  mailbox: string;
  // True once a lease RENEWAL has failed — the lease may have lapsed, so another instance could
  // re-acquire and double-process. The drain loop checks this between messages and aborts when set,
  // bounding the unlocked window to at most the one message in flight when the lease was lost.
  lost: boolean;
  // Release the lease (best-effort) and stop renewing. Always call this in a finally.
  release: () => Promise<void>;
};

export type DrainLockOptions = {
  log?: (...args: any[]) => void;
  // --- test seams (production omits all of these) ---
  client?: AxiosInstance;           // inject a (mock-adapter) axios instance
  sleep?: (ms: number) => Promise<void>;
  uuid?: () => string;
  now?: () => number;
  // Schedule the renewal callback; default uses an unref'd setInterval. Tests inject a capturing
  // stub so they can fire a renewal deterministically without real timers.
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
};

// #endregion

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultSetTimer = (fn: () => void, ms: number) => {
  const h = setInterval(fn, ms);
  // Don't keep the worker process alive just for the renewal timer.
  (h as any).unref?.();
  return { clear: () => clearInterval(h) };
};

/** Whether per-mailbox locking is active (false reverts process-mail to its pre-lock behavior). */
export function isDrainLockEnabled(): boolean {
  return DRAIN_LOCK_ENABLED;
}

/**
 * Lock-blob name for a mailbox. The mailbox is either a GUID or an email; lower-case it and reduce
 * to a safe blob-name charset so e.g. `escape@corespecialty.com` and a GUID both map to a stable,
 * collision-free blob name.
 */
export function lockBlobName(mailbox: string): string {
  const safe = mailbox.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `mailbox-${safe || "unknown"}.lock`;
}

/**
 * Acquire the per-mailbox drain lock.
 *
 * Returns:
 *  - a DrainLock when the lease is held by us (caller drains, then calls release() in a finally),
 *  - a no-op DrainLock when locking is disabled (caller drains unlocked — legacy behavior),
 *  - null when the mailbox is being drained by another instance (caller should defer/re-enqueue).
 *
 * Throws on a storage error (misconfig/outage) so the caller fails the drain rather than running
 * without mutual exclusion.
 */
export async function acquireDrainLock(
  mailbox: string,
  opts: DrainLockOptions = {}
): Promise<DrainLock | null> {
  if (!DRAIN_LOCK_ENABLED) {
    opts.log?.("disabled; draining without a lock", { mailbox });
    return { mailbox, lost: false, release: async () => {} };
  }

  const log = opts.log;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? defaultSetTimer;
  const leaseId = (opts.uuid ?? randomUUID)();
  const blob = lockBlobName(mailbox);

  const client = opts.client ?? (await buildStorageClient());

  const deadline = now() + ACQUIRE_WAIT_MS;
  let ensured = false;
  for (;;) {
    let result = await acquireOnce(client, blob, leaseId);

    // First acquire on a fresh deployment 404s because the container/blob don't exist yet. Create
    // them once and retry — the warm path never pays this cost.
    if (result === "missing") {
      if (ensured) throw new Error("drain-lock: lock blob still missing after ensure");
      await ensureContainerAndBlob(client, blob);
      ensured = true;
      result = await acquireOnce(client, blob, leaseId);
      if (result === "missing") throw new Error("drain-lock: lock blob still missing after ensure");
    }

    if (result === "acquired") {
      log?.("acquired", { mailbox, leaseId });
      // Shared mutable flag the renewal timer flips on failure; the lock exposes it via `lost`.
      const state = { lost: false };
      const stop = startRenewal(client, blob, leaseId, RENEW_MS, setTimer, state, log);
      return {
        mailbox,
        get lost() {
          return state.lost;
        },
        release: async () => {
          stop();
          await releaseLease(client, blob, leaseId).then(
            () => log?.("released", { mailbox, leaseId }),
            (e) => log?.("release failed (lease will auto-expire)", { mailbox, error: errInfo(e) })
          );
        },
      };
    }

    // result === "held": another instance owns this mailbox right now.
    if (now() >= deadline) {
      log?.("contended; deferring after wait", { mailbox, waitedMs: ACQUIRE_WAIT_MS });
      return null;
    }
    await sleep(ACQUIRE_POLL_MS);
  }
}

// #region Storage REST primitives

type AcquireResult = "acquired" | "held" | "missing";

/** One lease-acquire attempt. Maps the two expected non-success statuses to control-flow signals. */
async function acquireOnce(
  client: AxiosInstance,
  blob: string,
  leaseId: string
): Promise<AcquireResult> {
  try {
    await client.put(leasePath(blob), null, {
      headers: {
        "x-ms-lease-action": "acquire",
        "x-ms-lease-duration": String(LEASE_SECONDS),
        "x-ms-proposed-lease-id": leaseId,
      },
    });
    return "acquired";
  } catch (e) {
    const status = (e as AxiosError)?.response?.status;
    if (status === 409) return "held"; // LeaseAlreadyPresent
    if (status === 404) return "missing"; // ContainerNotFound / BlobNotFound
    throw e;
  }
}

async function renewLease(client: AxiosInstance, blob: string, leaseId: string): Promise<void> {
  await client.put(leasePath(blob), null, {
    headers: { "x-ms-lease-action": "renew", "x-ms-lease-id": leaseId },
  });
}

async function releaseLease(client: AxiosInstance, blob: string, leaseId: string): Promise<void> {
  await client.put(leasePath(blob), null, {
    headers: { "x-ms-lease-action": "release", "x-ms-lease-id": leaseId },
  });
}

/**
 * Create the lock container and the (0-byte) lock blob if they don't exist yet. Both
 * already-exists outcomes are the success case, so they're swallowed; anything else throws.
 */
async function ensureContainerAndBlob(client: AxiosInstance, blob: string): Promise<void> {
  try {
    await client.put(`/${LOCK_CONTAINER}?restype=container`);
  } catch (e) {
    // 409 ContainerAlreadyExists — fine (another instance created it).
    if ((e as AxiosError)?.response?.status !== 409) throw e;
  }
  try {
    await client.put(`/${LOCK_CONTAINER}/${encodeURIComponent(blob)}`, "", {
      headers: { "x-ms-blob-type": "BlockBlob", "If-None-Match": "*" },
    });
  } catch (e) {
    // 409/412 — blob already exists (If-None-Match:* failed). Fine.
    const status = (e as AxiosError)?.response?.status;
    if (status !== 409 && status !== 412) throw e;
  }
}

function leasePath(blob: string): string {
  return `/${LOCK_CONTAINER}/${encodeURIComponent(blob)}?comp=lease`;
}

/** Start the periodic lease renewal; returns a function that stops it. */
function startRenewal(
  client: AxiosInstance,
  blob: string,
  leaseId: string,
  intervalMs: number,
  setTimer: NonNullable<DrainLockOptions["setTimer"]>,
  state: { lost: boolean },
  log?: (...args: any[]) => void
): () => void {
  const timer = setTimer(() => {
    renewLease(client, blob, leaseId).then(
      () => log?.("renewed", { leaseId }),
      // A renew failure means the lease may have lapsed (another instance could acquire it and
      // double-process). Flag it so the drain loop aborts at the next message boundary rather than
      // continuing unlocked. The axios retry absorbs transient 429/503 blips before this fires, so a
      // failure reaching here is persistent enough to treat as lost (erring toward a safe re-drain).
      (e) => {
        state.lost = true;
        log?.("renew FAILED (lock lost; drain will abort)", { leaseId, error: errInfo(e) });
      }
    );
  }, intervalMs);
  return () => timer.clear();
}

/** The storage REST client, authenticated as the UAMI. Shared with seat-alert.ts. */
async function buildStorageClient(): Promise<AxiosInstance> {
  return buildSharedStorageClient({
    timeoutMs: HTTP_TIMEOUT_MS,
    errorPrefix: "drain-lock",
    accountName: process.env.DRAIN_LOCK_ACCOUNT_NAME,
  });
}

function errInfo(e: unknown): { status?: number; message: string } {
  const ax = e as AxiosError;
  return { status: ax?.response?.status, message: ax?.message ?? String(e) };
}

// #endregion