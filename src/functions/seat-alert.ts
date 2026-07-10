// src/functions/seat-alert.ts
// "Helpdesk is out of agent licenses" alert, emailed to the Management team at most once a day.
//
// WHY THIS EXISTS. Helpdesk exposes no seat/subscription/quota endpoint, so the relay cannot ask
// how many licenses are left — it only finds out by trying. When `sync-teams` invites a new AAD
// group member and the account is full, `POST /agents` fails:
//
//   409 {"error":{"type":"limitExceeded",
//                 "message":"agents count (15) is greater than subscription allows (14)",
//                 "details":{"paymentMethod":"manual","lackingSeats":1}}}
//
// That is a *business* condition, not a code fault: nobody can fix it but the people who buy seats.
// The sync already logs it at ERROR and throws (so the timer invocation is alertable), but an
// App Insights trace is not something a manager reads. So we mail them.
//
// ONCE PER DAY, ACROSS INSTANCES. sync-teams runs hourly and the seat limit persists until someone
// buys a license, so the naive version mails management every hour until they do. The throttle is a
// create-once blob: a blob named for today's date is PUT with `If-None-Match: *`, which Azure
// Storage rejects with 409/412 if it already exists. Whichever invocation creates it wins the day
// and sends; every later one sees the conflict and stays quiet. This is atomic at the storage layer,
// so it holds across the multi-instance Premium plan without a lock — the same reason drain-lock.ts
// uses blob primitives rather than in-process state (which a restart or a second instance defeats).
//
// FAILURE MODES:
//   - Storage unreachable => the claim THROWS and no mail is sent. Deliberately fail-CLOSED: we
//     cannot tell "first run today" from "already sent", and mailing managers hourly is worse than
//     missing one mail that is already an ERROR trace.
//   - Every recipient send fails => the claim blob is DELETED so the next hourly run retries today,
//     rather than the day being burned on an alert nobody received.
//   - No management team mapped for the environment (Development) => no mail, by design.
import { AxiosError, AxiosInstance } from "axios";
import { HelpdeskAgent } from "./helpdesk-client";
import { sendMailViaGraph } from "./graph-mail";
import { shouldSuppressRecipient } from "./routing";
import { formatAxiosError } from "./logging";
import { buildStorageClient } from "./storage-client";
import { envFlag, envPositiveNumber } from "./env";

// #region Configuration (read once at load)

/** Escape hatch: SEAT_ALERT_ENABLED=false silences the mail without a redeploy (ERROR logs remain). */
const SEAT_ALERT_ENABLED = envFlag(process.env.SEAT_ALERT_ENABLED, true);

/** The shared mailbox the alert is sent AS. Must be one the Application Access Policy licenses. */
export const SEAT_ALERT_FROM_MAILBOX =
  (process.env.SEAT_ALERT_FROM_MAILBOX ?? "").trim() || "escape@corespecialty.com";

/** Container for the daily-claim blobs. Same account as AzureWebJobsStorage (see storage-client.ts). */
const STATE_CONTAINER = process.env.SEAT_ALERT_CONTAINER ?? "relay-state";

const HTTP_TIMEOUT_MS = envPositiveNumber(process.env.SEAT_ALERT_HTTP_TIMEOUT_MS, 30_000, {
  integer: true,
});

// The "day" is the Eastern business day, not UTC. A UTC boundary rolls over at 8 PM ET, so the
// day's first hourly sync — and thus the alert — would land in the evening; ET rollover puts it in
// the early hours of the morning it refers to.
const ALERT_TIME_ZONE = process.env.SEAT_ALERT_TIME_ZONE ?? "America/New_York";

// #endregion

export type SeatLimitInfo = {
  /** Helpdesk's own message, e.g. "agents count (15) is greater than subscription allows (14)". */
  message: string;
  lackingSeats?: number;
};

export type SeatAlertOutcome = "sent" | "throttled" | "no-recipients" | "not-configured" | "disabled";

export type SeatAlertOptions = {
  graph: AxiosInstance;
  /** The agent list runTeamSync already fetched — recipients are its Management-team members. */
  agents: HelpdeskAgent[];
  /** Helpdesk team whose members get the mail; undefined => environment has none => no mail. */
  managementTeamId: string | undefined;
  /** The invites that were rejected for want of a seat. */
  blocked: { email: string; name?: string }[];
  info: SeatLimitInfo;
  fromMailbox?: string;
  environment?: string;
  log?: (...args: any[]) => void;
  // --- test seams (production omits all of these) ---
  client?: AxiosInstance; // inject a (mock-adapter) storage axios instance
  now?: () => Date;
};

/**
 * Recognise Helpdesk's "out of agent licenses" rejection. Returns null for every other error —
 * notably a *different* 409 (`POST /agents` also 409s when the email already exists), so this must
 * key on the error `type`, not the status code.
 */
export function seatLimitFromError(e: unknown): SeatLimitInfo | null {
  const raw = (e as AxiosError)?.response?.data as unknown;
  // Axios parses JSON responses, but a non-JSON content-type leaves `data` a string.
  let data: any = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const err = data?.error;
  if (!err || typeof err !== "object") return null;
  if (err.type !== "limitExceeded") return null;

  const lacking = err.details?.lackingSeats;
  return {
    message: String(err.message ?? "Helpdesk agent seat limit reached"),
    lackingSeats: typeof lacking === "number" ? lacking : undefined,
  };
}

/** `YYYY-MM-DD` in the alert time zone — the throttle's unit of "a day". */
export function alertDateKey(now: Date, timeZone: string = ALERT_TIME_ZONE): string {
  // en-CA formats as YYYY-MM-DD, which is both the ISO order and a safe blob-name charset.
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

/** Blob name for one environment's claim on one day. */
export function seatAlertBlobName(environment: string | undefined, dateKey: string): string {
  const env = ((environment ?? "").trim() || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  return `seat-alert-${env}-${dateKey}`;
}

function blobPath(blob: string): string {
  return `/${STATE_CONTAINER}/${encodeURIComponent(blob)}`;
}

/**
 * Try to claim today's alert. Returns true exactly once per (environment, day) across all
 * instances: the `If-None-Match: *` PUT is a storage-atomic create-if-absent, so a concurrent or
 * later invocation gets 409/412 and returns false. Any other storage failure throws (fail-closed).
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

/** Give today's claim back so the next hourly run can retry (used when every send failed). */
async function releaseClaim(client: AxiosInstance, blob: string): Promise<void> {
  await client.delete(blobPath(blob));
}

/**
 * Management-team members, deduped and loop-guarded. `shouldSuppressRecipient` keeps us from ever
 * mailing one of our own drain mailboxes — that would deposit the alert into an inbox the relay
 * drains, opening a ticket (see CLAUDE.md's outbound loop guard).
 */
export function seatAlertRecipients(agents: HelpdeskAgent[], managementTeamId: string): string[] {
  const out = new Set<string>();
  for (const a of agents) {
    if (!a.teamIDs?.includes(managementTeamId)) continue;
    const email = (a.email ?? "").trim().toLowerCase();
    if (!email || shouldSuppressRecipient(email)) continue;
    out.add(email);
  }
  return [...out];
}

export function seatAlertSubject(info: SeatLimitInfo, blockedCount: number): string {
  const who = blockedCount === 1 ? "1 user" : `${blockedCount} users`;
  const seats = info.lackingSeats ? ` (${info.lackingSeats} more needed)` : "";
  return `Helpdesk agent licenses exhausted${seats} — ${who} could not be added`;
}

export function seatAlertBody(opts: {
  info: SeatLimitInfo;
  blocked: { email: string; name?: string }[];
  environment?: string;
}): string {
  const { info, blocked, environment } = opts;
  const lines = [
    "The Helpdesk agent-license limit has been reached, so the automated AAD -> Helpdesk team sync",
    "could not add the following user(s) as Helpdesk agents:",
    "",
    ...blocked.map((b) => `  - ${b.name ? `${b.name} <${b.email}>` : b.email}`),
    "",
    `Helpdesk reported: ${info.message}`,
  ];
  if (info.lackingSeats) {
    lines.push(`Additional licenses needed: ${info.lackingSeats}`);
  }
  lines.push(
    "",
    "To resolve, purchase additional agent licenses in Helpdesk (or remove an unused agent).",
    "The sync retries every hour and will add these users automatically once seats are available;",
    "no manual invite is needed. This alert is sent at most once per day while the limit persists.",
    "",
    `Environment: ${environment ?? "unknown"}`,
    "This is an automated message from the CoreSpecialty Helpdesk relay.",
  );
  return lines.join("\n");
}

/**
 * Mail the Management team that Helpdesk is out of agent licenses — at most once per day.
 *
 * Best-effort by contract: the caller (runTeamSync) invokes this after the apply loops and must not
 * let an alert failure change the sync's own outcome. Returns what happened, for the log/summary.
 */
export async function sendSeatLimitAlert(opts: SeatAlertOptions): Promise<SeatAlertOutcome> {
  const { graph, agents, managementTeamId, blocked, info, environment, log } = opts;

  if (!SEAT_ALERT_ENABLED) {
    log?.("Team sync: seat-limit alert disabled (SEAT_ALERT_ENABLED=false)");
    return "disabled";
  }
  if (!managementTeamId) {
    log?.("Team sync: seat limit hit, but no management team is mapped for this environment", {
      environment: environment ?? "unknown",
    });
    return "not-configured";
  }

  const recipients = seatAlertRecipients(agents, managementTeamId);
  if (recipients.length === 0) {
    log?.("Team sync: seat limit hit, but the management team has no mailable agents", {
      managementTeamId,
    });
    return "no-recipients";
  }

  // Claim the day BEFORE sending, so two instances racing the same hour send once between them.
  const now = (opts.now ?? (() => new Date()))();
  const dateKey = alertDateKey(now);
  const blob = seatAlertBlobName(environment, dateKey);
  const client =
    opts.client ?? (await buildStorageClient({ timeoutMs: HTTP_TIMEOUT_MS, errorPrefix: "seat-alert" }));

  const claimed = await claimDailyAlert(
    client,
    blob,
    JSON.stringify({ claimedAt: now.toISOString(), environment, blocked: blocked.map((b) => b.email), info })
  );
  if (!claimed) {
    log?.("Team sync: seat-limit alert already sent today — suppressed", { blob });
    return "throttled";
  }

  const subject = seatAlertSubject(info, blocked.length);
  const body = seatAlertBody({ info, blocked, environment });
  const mailbox = opts.fromMailbox ?? SEAT_ALERT_FROM_MAILBOX;

  // Per-recipient isolation: one bad address must not deprive the rest of the team of the alert.
  let sent = 0;
  for (const to of recipients) {
    try {
      await sendMailViaGraph({ graph, mailbox, to, subject, body });
      sent++;
    } catch (e) {
      log?.("Team sync: seat-limit alert send FAILED", { to, error: formatAxiosError(e) });
    }
  }

  if (sent === 0) {
    // Nobody got it — hand the day back so the next hourly run tries again.
    try {
      await releaseClaim(client, blob);
    } catch (e) {
      log?.("Team sync: seat-limit alert claim release FAILED (no alert until tomorrow)", {
        blob,
        error: formatAxiosError(e),
      });
    }
    return "no-recipients";
  }

  log?.("Team sync: seat-limit alert sent to management", {
    recipients: sent,
    of: recipients.length,
    mailbox,
    blockedUsers: blocked.map((b) => b.email),
    lackingSeats: info.lackingSeats,
  });
  return "sent";
}
