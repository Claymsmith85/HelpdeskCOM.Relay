// src/functions/sync-failure-alert.ts
// The "team sync is failing" alert — an IT-category definition on top of the generic alert engine
// (alerts.ts, which owns routing, the once-daily throttle, and sending).
//
// WHY THIS EXISTS. runTeamSync isolates per-item failures (a 422 on an invite, a 500 on a team
// update, a Graph group read failing) and rethrows at the end, so the hourly timer invocation is
// marked failed — but that is an App Insights trace nobody reads until they go looking. The July
// 2026 `"status" is not allowed` 422 failed every hourly invite for weeks that way. This mails the
// Development / IT Support team a digest of the run's non-seat failures. (Seat-limit rejections are
// deliberately EXCLUDED — they are the licensing category, handled by seat-alert.ts; devs can't fix
// a full subscription.)
//
// THROTTLE KEY: the key embeds a coarse signature of the failure set — the sorted distinct
// `op:status` pairs, e.g. "sync-failure-invite422". A persistent failure therefore mails once per
// day (same signature => same daily claim), but a NEW failure mode appearing later the same day
// (say a 500 joining the 422) forms a new signature and still alerts, instead of hiding behind the
// morning's claim until tomorrow. The trade-off: a flapping failure alongside a persistent one can
// produce one mail per distinct combination per day — bounded, and better than silence.
import { AxiosError, AxiosInstance } from "axios";
import { HelpdeskAgent } from "./helpdesk-client";
import { safeJson } from "./logging";
import { AlertOutcome, sendAlert } from "./alerts";

/** Where in the sync the item failed. */
export type SyncFailureOp = "group-read" | "invite" | "team-update" | "delete";

export type SyncFailure = {
  op: SyncFailureOp;
  /** What was being acted on: an agent email, or an AAD group object ID for group-read. */
  target: string;
  error: unknown; // the raw caught error; rendered by describeError at build time
};

const MAX_ERROR_CHARS = 300;

/**
 * One human-readable line for a caught error: `HTTP <status> <type>: <message> (<details>)` when a
 * Helpdesk-style body is present, a capped body excerpt otherwise, the plain message for
 * non-HTTP errors. Feeds the email body — App Insights keeps the full formatAxiosError record.
 */
export function describeError(e: unknown): string {
  const cap = (s: string) => (s.length > MAX_ERROR_CHARS ? `${s.slice(0, MAX_ERROR_CHARS)}…` : s);
  const ax = e as AxiosError;
  const status = ax?.response?.status;
  if (!status) return cap((e as Error)?.message ?? String(e));

  let data: any = ax.response?.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      // keep the string; it becomes the excerpt below
    }
  }
  const err = data?.error;
  if (err && typeof err === "object") {
    const type = err.type ? ` ${err.type}` : "";
    const details = err.details !== undefined ? ` (${safeJson(err.details)})` : "";
    return cap(`HTTP ${status}${type}: ${err.message ?? ""}${details}`);
  }
  const excerpt = data === undefined || data === null ? "" : `: ${safeJson(data)}`;
  return cap(`HTTP ${status}${excerpt}`);
}

const statusOf = (e: unknown): number | undefined => (e as AxiosError)?.response?.status;

/**
 * Throttle key: "sync-failure-" + the sorted distinct `op<status>` signature (see file header).
 * Deterministic — insertion order and duplicates don't change it.
 */
export function syncFailureKey(failures: SyncFailure[]): string {
  const sig = [...new Set(failures.map((f) => `${f.op}${statusOf(f.error) ?? "err"}`))].sort();
  return `sync-failure-${sig.join("-")}`;
}

export function syncFailureSubject(failures: SyncFailure[], environment: string | undefined): string {
  const n = failures.length;
  return `Helpdesk relay: team sync failing (${n} error${n === 1 ? "" : "s"}) — ${environment ?? "unknown"}`;
}

/** Body content only — the engine appends the environment/automation footer. */
export function syncFailureBody(failures: SyncFailure[]): string {
  return [
    "The automated AAD -> Helpdesk team sync hit the following error(s) on its last run:",
    "",
    ...failures.map((f) => `  - ${f.op} ${f.target} — ${describeError(f.error)}`),
    "",
    "The sync retries every hour; if the cause persists this alert repeats at most once per day",
    "(a new kind of failure alerts again the same day). Full details are in Application Insights",
    "(traces at error severity from the sync-teams function).",
  ].join("\n");
}

export type SyncFailureAlertOptions = {
  graph: AxiosInstance;
  /** The agent list runTeamSync already fetched — recipients are its IT-team members. */
  agents: HelpdeskAgent[];
  failures: SyncFailure[];
  environment?: string;
  fromMailbox?: string;
  log?: (...args: any[]) => void;
  // --- test seams (production omits both) ---
  client?: AxiosInstance;
  now?: () => Date;
};

/**
 * Mail the IT team a digest of a sync run's non-seat failures — at most once per (failure
 * signature, day). Best-effort by contract: the caller (runTeamSync) must not let a failure here
 * change the sync's own outcome.
 */
export async function sendSyncFailureAlert(opts: SyncFailureAlertOptions): Promise<AlertOutcome> {
  const { failures } = opts;
  return sendAlert({
    category: "it",
    key: syncFailureKey(failures),
    subject: syncFailureSubject(failures, opts.environment),
    body: syncFailureBody(failures),
    detail: failures.map((f) => ({ op: f.op, target: f.target, error: describeError(f.error) })),
    graph: opts.graph,
    agents: opts.agents,
    environment: opts.environment,
    fromMailbox: opts.fromMailbox,
    log: opts.log,
    client: opts.client,
    now: opts.now,
  });
}