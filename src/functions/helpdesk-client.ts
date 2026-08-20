// src/functions/helpdesk-client.ts
// Helpdesk.com REST client + the ticket operations both functions need. Centralizing this
// (a) honors HELPDESK_BASE_URL everywhere, (b) derives auth in one place, and (c) keeps the
// inbound worker and the webhook handler from re-implementing Helpdesk HTTP calls.
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
import { ListTicketsResponse } from "../types/ListTicketsResponse";
import { extractTicketRef, normalizeRef } from "./subject";
import { attachRetryInterceptor, isRetryable } from "./http-retry";
import { envPositiveNumber, requireEnv } from "./env";
import { attachRateLimitInterceptor, createRateLimiter } from "./rate-limit";
import { summarizeRequestBody, type ApiCallLogger } from "./logging";
import {
  attachHelpdeskGateInterceptor,
  gateCooldownOptions,
  gateEnabled,
  gateMaxWaitMs,
  helpdeskGate,
} from "./helpdesk-gate";

const HELP_DESK_BASE_URL =
  process.env.HELPDESK_BASE_URL ?? "https://api.helpdesk.com/v1";

// Per-request timeout so a hung Helpdesk call fails fast instead of stalling the whole drain.
const HELPDESK_TIMEOUT_MS = envPositiveNumber(process.env.HELPDESK_HTTP_TIMEOUT_MS, 60_000);

const DEFAULT_HELPDESK_RATE_LIMIT_RPS = 5;
const DEFAULT_HELPDESK_RETRY_MAX_RETRIES = 5;
const DEFAULT_HELPDESK_RETRY_MAX_DELAY_MS = 60_000;
const helpdeskLimiter = createRateLimiter();
const HELPDESK_CLIENT_WIRED = Symbol("helpdesk-client interceptors attached");
// One name for this API across the retry labeling and the per-call telemetry.
const HELPDESK_API_NAME = "Helpdesk";

export type TicketSummary = Pick<ListTicketsResponse, "ID" | "shortID" | "subject">;

type HelpdeskTicketRead = { ID: string; shortID?: string };

// Per-attempt request timing, alongside http-retry's __retryCount on the same config object.
type TimedConfig = AxiosRequestConfig & { __startedAt?: number; __retryCount?: number };

/**
 * Emit ONE Application Insights entry per Helpdesk request attempt.
 *
 * The eleven operations below take a bare AxiosInstance and log nothing of their own, so without
 * this a throttled or failed call is invisible unless it happens to escape to a handler's
 * stepError — there is no way to count calls, see which endpoint throttled, or watch retry pressure
 * build. Registering here covers every operation for free.
 *
 * Severity is chosen so `traces | where severityLevel >= 3` stays a real failure signal:
 *   - 2xx, first try          -> info     "Helpdesk API"
 *   - 2xx after retries       -> warning  "Helpdesk API ok after retries"
 *   - failed, will be retried -> warning  "Helpdesk API retryable failure"   (each 429 is visible)
 *   - failed, terminal        -> error    "Helpdesk API FAILED"
 *
 * MUST be registered BEFORE attachRetryInterceptor: response interceptors run in registration
 * order, so this one observes every individual attempt rather than only the final outcome. Request
 * bodies are never logged verbatim — only their shape (see summarizeRequestBody).
 */
function attachCallLogInterceptor(
  client: AxiosInstance,
  logger: ApiCallLogger,
  maxRetries: number
): AxiosInstance {
  client.interceptors.request.use((config) => {
    (config as TimedConfig).__startedAt = Date.now();
    return config;
  });

  const elapsed = (config: TimedConfig | undefined) => {
    const startedAt = config?.__startedAt;
    return typeof startedAt === "number" ? Date.now() - startedAt : undefined;
  };
  // `api` is stamped here rather than read off the error: http-retry labels the error in ITS
  // interceptor, which runs after this one, so at log time the label is not on the object yet.
  const where = (config: TimedConfig | undefined) => ({
    api: HELPDESK_API_NAME,
    method: (config?.method ?? "get").toUpperCase(),
    path: config?.url,
  });

  client.interceptors.response.use(
    (response) => {
      const config = response.config as TimedConfig;
      const retries = config.__retryCount ?? 0;
      const data = { ...where(config), status: response.status, ms: elapsed(config), retries };
      if (retries > 0) logger.stepWarn?.("Helpdesk API ok after retries", data);
      else logger.step?.("Helpdesk API", data);
      return response;
    },
    (error: AxiosError) => {
      const config = error.config as TimedConfig | undefined;
      const attempt = config?.__retryCount ?? 0;
      const data = {
        ...where(config),
        status: error.response?.status,
        ms: elapsed(config),
        retries: attempt,
        requestBody: summarizeRequestBody(config?.data),
      };
      // Mirrors http-retry's own decision, so the two can't disagree about what is terminal.
      if (attempt < maxRetries && isRetryable(error)) {
        logger.stepWarn?.("Helpdesk API retryable failure", data);
      } else {
        logger.stepError?.("Helpdesk API FAILED", error, data);
      }
      throw error;
    }
  );

  return client;
}

export type HelpdeskClientOptions = {
  /**
   * How long one request may wait on the global throttle gate before dispatching anyway. The
   * webhook passes a small budget because a slow 200 makes Helpdesk redeliver and duplicate email;
   * the drain and team sync check the gate up front and defer instead of reaching this.
   */
  gateMaxWaitMs?: number;
};

/**
 * Create an Axios client for the Helpdesk API (base URL + auth header).
 *
 * `logger` is optional and follows the createGraphClientFromEnv(log) precedent: pass a handler's
 * `createStepLogger` result to get one telemetry entry per request attempt. Omitted ⇒ silent.
 *
 * INTERCEPTOR ORDER IS LOAD-BEARING. Axios runs request interceptors in REVERSE registration order
 * and response interceptors in registration order, so registering
 *   call-log -> rate-limit -> gate -> retry
 * yields, per request:  gate wait -> rate-limit slot -> start-time stamp -> HTTP
 * and per response:     call-log entry -> gate penalty -> retry decision.
 * Each of those orderings is required:
 *   - gate BEFORE rate-limit, or a waiter holds a dispatch slot through the cooldown and the whole
 *     backlog fires unpaced the moment the gate opens (see helpdesk-gate.ts).
 *   - start-time stamped LAST, so the logged `ms` measures the HTTP call and not time spent queued.
 *   - call-log BEFORE retry, so every individual attempt is logged rather than only the outcome.
 *   - gate penalty BEFORE retry, so the retry's own sleep already reflects the new cooldown.
 */
export function createHelpdeskClient(
  logger: ApiCallLogger = {},
  opts: HelpdeskClientOptions = {}
): AxiosInstance {
  const client = axios.create({
    baseURL: HELP_DESK_BASE_URL,
    timeout: HELPDESK_TIMEOUT_MS,
    headers: {
      Authorization: `Basic ${requireEnv("HELPDESK_PAT")}`,
      "User-Agent": "cs-azurefn-email/1.0 (+https://corespecialty.com)",
    },
  });
  if ((client as any)[HELPDESK_CLIENT_WIRED]) return client;
  (client as any)[HELPDESK_CLIENT_WIRED] = true;

  const maxRetries = envPositiveNumber(
    process.env.HELPDESK_RETRY_MAX_RETRIES,
    DEFAULT_HELPDESK_RETRY_MAX_RETRIES,
    { integer: true }
  );

  attachCallLogInterceptor(client, logger, maxRetries);

  const rps = envPositiveNumber(
    process.env.HELPDESK_RATE_LIMIT_RPS,
    DEFAULT_HELPDESK_RATE_LIMIT_RPS
  );
  const intervalMs = rps > 1000 ? 0 : Math.ceil(1000 / rps);
  attachRateLimitInterceptor(client, helpdeskLimiter, intervalMs);

  if (gateEnabled()) {
    attachHelpdeskGateInterceptor(client, helpdeskGate, {
      maxWaitMs: opts.gateMaxWaitMs ?? gateMaxWaitMs(),
      cooldown: gateCooldownOptions(),
      onWaited: (waitedForMs, stillGatedMs) =>
        logger.stepWarn?.("Helpdesk gate: waited on global cooldown", {
          api: HELPDESK_API_NAME,
          waitedForMs,
          stillGatedMs,
          // Non-zero means the wait budget ran out and the request is dispatching anyway.
          proceedingAnyway: stillGatedMs > 0,
        }),
      onPenalized: (cooldownMs, retryAfterMs) =>
        logger.stepWarn?.("Helpdesk gate: 429 opened a global cooldown", {
          api: HELPDESK_API_NAME,
          cooldownMs,
          retryAfterMs,
        }),
    });
  }

  return attachRetryInterceptor(client, {
    apiName: HELPDESK_API_NAME,
    maxRetries,
    maxDelayMs: envPositiveNumber(
      process.env.HELPDESK_RETRY_MAX_DELAY_MS,
      DEFAULT_HELPDESK_RETRY_MAX_DELAY_MS
    ),
  });
}

/**
 * Fetch a ticket and return its shortID (throws if missing).
 */
export async function getTicketShortId(
  helpdesk: AxiosInstance,
  ticketId: string
): Promise<string> {
  const res = await helpdesk.get<HelpdeskTicketRead>(`/tickets/${ticketId}`);
  const shortId = res.data?.shortID;
  if (!shortId) {
    throw new Error(`HelpDesk ticket read: shortID missing for ticketId ${ticketId}`);
  }
  return shortId;
}

/**
 * List tickets for a requester email.
 */
export async function listTicketsByRequester(
  helpdesk: AxiosInstance,
  requesterEmail: string
): Promise<TicketSummary[]> {
  const res = await helpdesk.get<TicketSummary[]>("/tickets", {
    params: { requester: { email: requesterEmail } },
  });
  return res.data ?? [];
}

// Narrow read type for the by-shortID lookup below (the full list response is much larger).
type TicketByRefRead = {
  ID: string;
  shortID?: string;
  subject?: string;
  requester?: { email?: string | null } | null;
  cc?: unknown; // [{email, name|null}] on live payloads; parsed defensively
  followers?: unknown; // bare agent-ID strings on live payloads; parsed defensively
};

/** A by-ref match plus the fields the caller needs to authorize threading into it. */
export type TicketByRef = TicketSummary & {
  requesterEmail: string | null;
  ccEmails: string[]; // lowercased people-in-the-loop addresses
  followerIds: string[]; // follower agent IDs (resolve to emails via listAgents)
};

/**
 * Find a ticket by its shortID (the `[#shortID]` threading tag), for inbound replies from a
 * NON-requester (follower / person-in-the-loop) whose sender-scoped lookup can't see the ticket.
 * Returns the ticket's requester/cc/followers too, so the caller can verify the SENDER is part of
 * the ticket's audience before threading — the tag alone must never grant write access (it appears
 * in every outbound subject, so anyone forwarded a relay email has seen one).
 *
 * The `shortID` query param may or may not be honored by the API — so the result is ALWAYS
 * verified client-side (`normalizeRef` match on the returned bare array). If the API ignores the
 * param and the ticket isn't in the returned page, this returns null and the caller falls through
 * to today's new-ticket behavior — a miss is safe, a wrong match never happens.
 *
 * Errors: a definitive 4xx returns null (fall through); a TRANSIENT status (408/429, post-retry)
 * or 5xx/transport error RETHROWS so the queue retries the message instead of mis-filing the
 * reply into a new ticket (a rate-limit is not a "no such ticket").
 */
export async function findTicketByShortId(
  helpdesk: AxiosInstance,
  shortId: string
): Promise<TicketByRef | null> {
  let list: TicketByRefRead[];
  try {
    const res = await helpdesk.get<TicketByRefRead[]>("/tickets", {
      params: { shortID: shortId },
    });
    list = Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    const status = (e as AxiosError)?.response?.status;
    if (status === 408 || status === 429) throw e; // transient, not definitive — retry, never mis-file
    if (status && status >= 400 && status < 500) return null;
    throw e;
  }
  const match = list.find((t) => normalizeRef(t.shortID) === normalizeRef(shortId));
  if (!match) return null;
  return {
    ID: match.ID,
    shortID: match.shortID ?? shortId,
    subject: match.subject ?? "",
    requesterEmail: match.requester?.email ?? null,
    ccEmails: (Array.isArray(match.cc) ? match.cc : [])
      .map((e: any) => (typeof e === "string" ? e : e?.email))
      .filter((e: any): e is string => typeof e === "string" && e.includes("@"))
      .map((e) => e.trim().toLowerCase()),
    followerIds: (Array.isArray(match.followers) ? match.followers : [])
      .map((f: any) => (typeof f === "string" ? f : f?.ID))
      .filter((f: any): f is string => typeof f === "string" && !!f),
  };
}

/**
 * Append a message to a ticket, authored by a client or agent.
 */
export async function updateTicketMessage(opts: {
  helpdesk: AxiosInstance;
  ticketId: string;
  text: string;
  authorType: "client" | "agent";
}): Promise<void> {
  const { helpdesk, ticketId, text, authorType } = opts;
  await helpdesk.patch(
    `/tickets/${ticketId}`,
    { message: { text }, author: { type: authorType } },
    { headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Create a ticket; returns the new ticket ID.
 */
export async function createTicket(opts: {
  helpdesk: AxiosInstance;
  subject: string;
  requesterEmail: string;
  requesterName: string;
  teamId: string;
  messageText: string;
  customFields?: Record<string, any>;
}): Promise<string> {
  const { helpdesk, subject, requesterEmail, requesterName, teamId, messageText, customFields } = opts;

  const res = await helpdesk.post(
    "/tickets",
    {
      subject,
      requester: { email: requesterEmail, name: requesterName },
      assignment: { team: { ID: teamId }, agent: null },
      author: { type: "client" },
      customFields: customFields ?? {},
      message: { text: messageText },
    },
    { headers: { "Content-Type": "application/json" } }
  );

  const id: string | undefined = (res.data && (res.data.ID ?? res.data.id)) as string | undefined;
  if (!id) throw new Error("HelpDesk createTicket: no ticket ID returned");
  return id;
}

// ----- Agent / team operations (used by the AAD-group -> Helpdesk-team sync) -----
//
// Helpdesk has no separate "team membership" resource: a team is a group of agents, and membership
// lives as the `teamIDs` array ON each agent. So syncing a group into a team means PATCHing agents'
// teamIDs. All list endpoints return a bare array (no pagination wrapper / cursor in the v1 API).

export type HelpdeskAgent = {
  ID: string;
  email: string;
  name?: string;
  roles: string[];
  teamIDs: string[];
  status?: string; // "active" | "invited"
};

export type HelpdeskTeam = { ID: string; name?: string };

/**
 * List all agents (each carrying its `teamIDs` + `status`).
 */
export async function listAgents(helpdesk: AxiosInstance): Promise<HelpdeskAgent[]> {
  const res = await helpdesk.get<HelpdeskAgent[]>("/agents");
  return res.data ?? [];
}

/**
 * List all teams. Used to validate the group->team map points at real teams (and for logging).
 */
export async function listTeams(helpdesk: AxiosInstance): Promise<HelpdeskTeam[]> {
  const res = await helpdesk.get<HelpdeskTeam[]>("/teams");
  return res.data ?? [];
}

/**
 * Invite/create an agent into the given team(s); returns the new agent ID. The new agent lands in
 * Helpdesk's default "invited" state (Helpdesk sends them the invite).
 *
 * Do NOT add `status` to this body: the create schema rejects the key outright with a 422
 * (`"status" is not allowed`), despite the public docs listing it as an optional property.
 */
export async function inviteAgent(opts: {
  helpdesk: AxiosInstance;
  email: string;
  name: string;
  roles: string[];
  teamIDs: string[];
}): Promise<string> {
  const { helpdesk, email, name, roles, teamIDs } = opts;
  const res = await helpdesk.post(
    "/agents",
    { email, name, roles, teamIDs },
    { headers: { "Content-Type": "application/json" } }
  );
  const id: string | undefined = (res.data && (res.data.ID ?? res.data.id)) as string | undefined;
  if (!id) throw new Error("HelpDesk inviteAgent: no agent ID returned");
  return id;
}

/**
 * Replace an agent's full team-membership list (PATCH teamIDs). The caller computes the new list so
 * non-mapped (manually-assigned) teams are preserved.
 */
export async function updateAgentTeams(
  helpdesk: AxiosInstance,
  agentId: string,
  teamIDs: string[]
): Promise<void> {
  await helpdesk.patch(
    `/agents/${agentId}`,
    { teamIDs },
    { headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Delete an agent (frees the Helpdesk license). Irreversible — the sync only does this for an agent
 * left in zero teams after a group-leave.
 */
export async function deleteAgent(helpdesk: AxiosInstance, agentId: string): Promise<void> {
  await helpdesk.delete(`/agents/${agentId}`);
}

// Minimum length for the subject-substring fallback. A very short, generic ticket subject (e.g.
// "Help", "Bug") would otherwise act as a catch-all — every inbound email *containing* that word
// gets misthreaded into that one ticket. Below this length we rely solely on the [#shortID] tag
// (which the relay embeds in every outbound subject), which is the reliable threading mechanism.
const MIN_SUBSTRING_MATCH_LEN = 6;

/**
 * Locate an existing ticket for an inbound email.
 * Prefers the embedded "[#<shortID>]" reference tag, then a guarded subject-substring match
 * (an empty or very short ticket subject must never match every inbound email).
 */
export function findExistingTicket(
  subject: string,
  tickets: TicketSummary[]
): TicketSummary | null {
  const ref = extractTicketRef(subject);
  if (ref) {
    const byRef = tickets.find((t) => normalizeRef(t.shortID) === normalizeRef(ref));
    if (byRef) return byRef;
  }

  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const target = norm(subject);
  if (!target) return null;

  return (
    tickets.find((t) => {
      const ticketSubject = norm(t.subject);
      return ticketSubject.length >= MIN_SUBSTRING_MATCH_LEN && target.includes(ticketSubject);
    }) ?? null
  );
}
