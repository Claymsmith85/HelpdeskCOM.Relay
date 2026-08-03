// src/functions/seat-alert.ts
// The "Helpdesk is out of agent licenses" alert — a LICENSING-category definition on top of the
// generic alert engine (alerts.ts, which owns routing, the once-daily throttle, and sending).
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
// App Insights trace is not something a manager reads. So we mail them — routed to the licensing
// team (the Mgmt. Team in Production; no team in Development, so Dev sends nothing), throttled to
// once per environment per Eastern day under the stable key "seat-limit" (the condition persists
// until someone buys a seat, so a persistent-condition key is exactly right).
import { AxiosError, AxiosInstance } from "axios";
import { HelpdeskAgent } from "./helpdesk-client";
import { AlertOutcome, sendAlert } from "./alerts";

export type SeatLimitInfo = {
  /** Helpdesk's own message, e.g. "agents count (15) is greater than subscription allows (14)". */
  message: string;
  lackingSeats?: number;
};

export type SeatAlertOptions = {
  graph: AxiosInstance;
  /** The agent list runTeamSync already fetched — recipients are its licensing-team members. */
  agents: HelpdeskAgent[];
  /** The invites that were rejected for want of a seat. */
  blocked: { email: string; name?: string }[];
  info: SeatLimitInfo;
  environment?: string;
  fromMailbox?: string;
  log?: (...args: any[]) => void;
  // --- test seams (production omits both) ---
  client?: AxiosInstance;
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

export function seatAlertSubject(info: SeatLimitInfo, blockedCount: number): string {
  const who = blockedCount === 1 ? "1 user" : `${blockedCount} users`;
  const seats = info.lackingSeats ? ` (${info.lackingSeats} more needed)` : "";
  return `Helpdesk agent licenses exhausted${seats} — ${who} could not be added`;
}

/** Body content only — the engine appends the environment/automation footer. */
export function seatAlertBody(opts: {
  info: SeatLimitInfo;
  blocked: { email: string; name?: string }[];
}): string {
  const { info, blocked } = opts;
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
    "no manual invite is needed. This alert is sent at most once per day while the limit persists."
  );
  return lines.join("\n");
}

/**
 * Mail the licensing team that Helpdesk is out of agent licenses — at most once per day.
 * Best-effort by contract: the caller (runTeamSync) must not let a failure here change the sync's
 * own outcome.
 */
export async function sendSeatLimitAlert(opts: SeatAlertOptions): Promise<AlertOutcome> {
  const { blocked, info } = opts;
  return sendAlert({
    category: "licensing",
    key: "seat-limit",
    subject: seatAlertSubject(info, blocked.length),
    body: seatAlertBody({ info, blocked }),
    detail: { blocked: blocked.map((b) => b.email), info },
    graph: opts.graph,
    agents: opts.agents,
    environment: opts.environment,
    fromMailbox: opts.fromMailbox,
    log: opts.log,
    client: opts.client,
    now: opts.now,
  });
}