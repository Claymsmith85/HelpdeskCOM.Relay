// src/functions/alerts.ts
// The generic email-alert engine: every "a human must hear about this" mail the relay sends goes
// through sendAlert(). It owns the parts every alert needs and no alert should reimplement:
//
//   ROUTING.   Each alert has a CATEGORY ("it" | "licensing"; see team-mapping.ts), and each
//              category routes to one Helpdesk team per environment (ALERT_TEAMS_BY_ENV). The
//              recipients are that team's members on the agent list the caller already fetched —
//              zero extra API calls, and the list is loop-guarded (shouldSuppressRecipient) so an
//              alert can never be mailed into a drain mailbox and open a ticket.
//
//   THROTTLE.  At most one mail per (environment, throttle KEY, Eastern day), enforced by a
//              create-once blob: a blob named for the key + day is PUT with `If-None-Match: *`,
//              which Azure Storage rejects with 409/412 if it already exists. Whichever invocation
//              creates it wins the day and sends; every later one sees the conflict and stays
//              quiet. Atomic at the storage layer, so it holds across the multi-instance Premium
//              plan without a lock — the same reason drain-lock.ts uses blob primitives rather
//              than in-process state (which a restart or a second instance defeats). The "day" is
//              the Eastern business day, not UTC: a UTC boundary rolls over at 8 PM ET, so the
//              day's first alert would land in the evening.
//
//   FAILURE MODES.
//     - Storage unreachable => the claim THROWS and no mail is sent. Deliberately fail-CLOSED: we
//       cannot tell "first run today" from "already sent", and mailing people hourly is worse than
//       missing one mail that is already an ERROR trace.
//     - Every recipient send fails => the claim blob is DELETED so the next run retries today,
//       rather than the day being burned on an alert nobody received.
//     - No team mapped for the (environment, category) => no mail, by design (e.g. licensing in
//       Development).
//
// ADDING A NEW ALERT: write a definition module (subject + body builders and a thin send wrapper;
// see seat-alert.ts and sync-failure-alert.ts) and call sendAlert() with a category and a unique
// throttle key. A new CATEGORY additionally needs a row in team-mapping.ts's ALERT_TEAMS_BY_ENV.
import { AxiosError, AxiosInstance } from "axios";
import { HelpdeskAgent } from "./helpdesk-client";
import { sendMailViaGraph } from "./graph-mail";
import { shouldSuppressRecipient } from "./routing";
import { formatAxiosError } from "./logging";
import { buildStorageClient } from "./storage-client";
import { AlertCategory, alertTeamForEnvironment } from "./team-mapping";
import { envFlag, envPositiveNumber } from "./env";

export { AlertCategory } from "./team-mapping";

// #region Configuration

/** The shared mailbox alerts are sent AS. Must be one the Application Access Policy licenses. */
export const ALERT_FROM_MAILBOX =
  (process.env.ALERT_FROM_MAILBOX ?? "").trim() || "escape@corespecialty.com";

/** Container for the daily-claim blobs. Same account as AzureWebJobsStorage (see storage-client.ts). */
const STATE_CONTAINER = process.env.ALERT_CONTAINER ?? "relay-state";

const HTTP_TIMEOUT_MS = envPositiveNumber(process.env.ALERT_HTTP_TIMEOUT_MS, 30_000, {
  integer: true,
});

const ALERT_TIME_ZONE = process.env.ALERT_TIME_ZONE ?? "America/New_York";

/**
 * Kill switches, read PER-INVOCATION so they flip via an app setting with no redeploy:
 * `ALERT_ENABLED=false` silences every alert; `ALERT_IT_ENABLED=false` /
 * `ALERT_LICENSING_ENABLED=false` silence one category (the conditions are still logged at ERROR).
 * All default ON.
 */
export function alertEnabled(category: AlertCategory): boolean {
  if (!envFlag(process.env.ALERT_ENABLED, true)) return false;
  return envFlag(process.env[`ALERT_${category.toUpperCase()}_ENABLED`], true);
}

// #endregion

export type AlertOutcome =
  | "sent"
  | "throttled" // already sent today for this (environment, key)
  | "no-recipients" // the routed team has no mailable agents
  | "send-failed" // every recipient send failed (the day's claim was released)
  | "not-configured" // no team mapped for this (environment, category)
  | "disabled"; // killed by ALERT_ENABLED / ALERT_<CATEGORY>_ENABLED

export type AlertOptions = {
  category: AlertCategory;
  /**
   * Throttle key: at most one mail per (environment, key, Eastern day). Use a stable slug per
   * alert type (e.g. "seat-limit"). A key may embed a coarse failure signature so a NEW failure
   * mode the same day still alerts (see sync-failure-alert.ts) — but it must be stable while the
   * same condition persists, or the throttle is defeated.
   */
  key: string;
  subject: string;
  body: string; // content only — the engine appends the environment/automation footer
  graph: AxiosInstance;
  /** The agent list the caller already fetched — recipients are the routed team's members on it. */
  agents: HelpdeskAgent[];
  /** RELAY_ENVIRONMENT — selects the routing row and namespaces the daily claim. */
  environment?: string;
  /** Extra context serialized into the claim blob, for forensics. */
  detail?: unknown;
  fromMailbox?: string;
  log?: (...args: any[]) => void;
  // --- test seams (production omits both) ---
  client?: AxiosInstance; // inject a (mock-adapter) storage axios instance
  now?: () => Date;
};

/** `YYYY-MM-DD` in the alert time zone — the throttle's unit of "a day". */
export function alertDateKey(now: Date, timeZone: string = ALERT_TIME_ZONE): string {
  // en-CA formats as YYYY-MM-DD, which is both the ISO order and a safe blob-name charset.
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

const blobSafe = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");

/** Blob name for one (environment, category, key) claim on one day. */
export function alertBlobName(
  environment: string | undefined,
  category: AlertCategory,
  key: string,
  dateKey: string
): string {
  const env = blobSafe((environment ?? "").trim() || "unknown");
  return `alert-${env}-${blobSafe(category)}-${blobSafe(key)}-${dateKey}`;
}

function blobPath(blob: string): string {
  return `/${STATE_CONTAINER}/${encodeURIComponent(blob)}`;
}

/**
 * Try to claim today's alert. Returns true exactly once per blob name across all instances: the
 * `If-None-Match: *` PUT is a storage-atomic create-if-absent, so a concurrent or later invocation
 * gets 409/412 and returns false. Any other storage failure throws (fail-closed).
 */
export async function claimDailyAlert(
  client: AxiosInstance,
  blob: string,
  body: string
): Promise<boolean> {
  try {
    await client.put(`/${STATE_CONTAINER}?restype=container`);
  } catch (e) {
    // 409 ContainerAlreadyExists — fine (another instance, or an earlier day, created it).
    if ((e as AxiosError)?.response?.status !== 409) throw e;
  }
  try {
    await client.put(blobPath(blob), body, {
      headers: { "x-ms-blob-type": "BlockBlob", "If-None-Match": "*", "Content-Type": "application/json" },
    });
    return true;
  } catch (e) {
    const status = (e as AxiosError)?.response?.status;
    if (status === 409 || status === 412) return false; // already claimed today
    throw e;
  }
}

/** Give today's claim back so the next run can retry (used when every send failed). */
async function releaseClaim(client: AxiosInstance, blob: string): Promise<void> {
  await client.delete(blobPath(blob));
}

/**
 * The routed team's members, deduped and loop-guarded. `shouldSuppressRecipient` keeps us from
 * ever mailing one of our own drain mailboxes — that would deposit the alert into an inbox the
 * relay drains, opening a ticket (see CLAUDE.md's outbound loop guard).
 */
export function alertRecipients(agents: HelpdeskAgent[], teamId: string): string[] {
  const out = new Set<string>();
  for (const a of agents) {
    if (!a.teamIDs?.includes(teamId)) continue;
    const email = (a.email ?? "").trim().toLowerCase();
    if (!email || shouldSuppressRecipient(email)) continue;
    out.add(email);
  }
  return [...out];
}

/**
 * Send one alert to its category's Helpdesk team — at most once per (environment, key, day).
 *
 * Best-effort by contract: callers invoke this off their own error paths and must not let an
 * alert failure change their own outcome (wrap the call; see runTeamSync). Returns what happened,
 * for the log/summary.
 */
export async function sendAlert(opts: AlertOptions): Promise<AlertOutcome> {
  const { category, key, graph, agents, environment, log } = opts;
  const tag = `Alert [${category}/${key}]`;

  if (!alertEnabled(category)) {
    log?.(`${tag}: disabled (ALERT_ENABLED / ALERT_${category.toUpperCase()}_ENABLED)`);
    return "disabled";
  }

  const teamId = alertTeamForEnvironment(environment, category);
  if (!teamId) {
    log?.(`${tag}: no team mapped for this environment — not sent`, {
      environment: environment ?? "unknown",
    });
    return "not-configured";
  }

  const recipients = alertRecipients(agents, teamId);
  if (recipients.length === 0) {
    log?.(`${tag}: the routed team has no mailable agents — not sent`, { teamId });
    return "no-recipients";
  }

  // Claim the day BEFORE sending, so two instances racing the same hour send once between them.
  const now = (opts.now ?? (() => new Date()))();
  const blob = alertBlobName(environment, category, key, alertDateKey(now));
  const client =
    opts.client ?? (await buildStorageClient({ timeoutMs: HTTP_TIMEOUT_MS, errorPrefix: "alerts" }));

  const claimed = await claimDailyAlert(
    client,
    blob,
    JSON.stringify({
      claimedAt: now.toISOString(),
      environment,
      category,
      key,
      subject: opts.subject,
      detail: opts.detail,
    })
  );
  if (!claimed) {
    log?.(`${tag}: already sent today — suppressed`, { blob });
    return "throttled";
  }

  const body =
    `${opts.body.replace(/\n+$/, "")}\n\n` +
    `Environment: ${environment ?? "unknown"}\n` +
    "This is an automated message from the CoreSpecialty Helpdesk relay.";
  const mailbox = opts.fromMailbox ?? ALERT_FROM_MAILBOX;

  // Per-recipient isolation: one bad address must not deprive the rest of the team of the alert.
  let sent = 0;
  for (const to of recipients) {
    try {
      await sendMailViaGraph({ graph, mailbox, to, subject: opts.subject, body });
      sent++;
    } catch (e) {
      log?.(`${tag}: send FAILED`, { to, error: formatAxiosError(e) });
    }
  }

  if (sent === 0) {
    // Nobody got it — hand the day back so the next run tries again.
    try {
      await releaseClaim(client, blob);
    } catch (e) {
      log?.(`${tag}: claim release FAILED (no retry until tomorrow)`, {
        blob,
        error: formatAxiosError(e),
      });
    }
    return "send-failed";
  }

  log?.(`${tag}: sent`, { recipients: sent, of: recipients.length, mailbox, teamId });
  return "sent";
}
