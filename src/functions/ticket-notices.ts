// src/functions/ticket-notices.ts
// Follower / people-in-the-loop notice emails for ticket events (no Function registration — the
// thin call lives in helpdesk.ts, the templates in templates.ts). Helpdesk's native notifications
// are FULLY disabled (requester and agent alike; see CLAUDE.md invariant #2), so without this a
// ticket's followers (`payload.followers`, agents) and people-in-the-loop (`payload.cc`, external
// emails) hear nothing when a ticket changes. Gated by NOTICES_TOGGLE at the caller.
//
// Per-audience visibility (decided with the business):
//   - FOLLOWERS (internal agents): every classified event — public messages, private notes,
//     "System note:" texts, status changes, assignment changes.
//   - PEOPLE IN THE LOOP (external): public messages and status changes ONLY — never private or
//     system notes, and never assignment changes (they name internal agents/teams).
//
// Echo control: the requester (they have their own reply path), the event's author, and the
// relayed-from sender (a non-requester whose reply the inbound worker threaded — see
// templates.ts's marker pair) are excluded, and every survivor passes shouldSuppressRecipient so
// a notice can never land in a drain mailbox and open a ticket (the outbound loop guard).
//
// Field-shape caveat: `followers[]` / `cc[]` element shapes are UNVERIFIED against a live payload
// (typed any[] from a sample where both were empty). extractNoticeRecipients is deliberately
// defensive — email strings, {email} objects, {ID} objects (agent IDs resolved via listAgents) —
// and logs the raw arrays whenever non-empty so the real shape can be confirmed in App Insights;
// tightening it is a one-function change.
import { AxiosInstance } from "axios";
import { TicketUpdatedPayload } from "../types/TicketUpdatePayload";
import { sendMailViaGraph } from "./graph-mail";
import { HelpdeskAgent, listAgents } from "./helpdesk-client";
import { shouldSuppressRecipient } from "./routing";
import { formatAxiosError, safeJson, type StepFn, type StepErrorFn } from "./logging";
import {
  noticeAssignmentEmail,
  noticeMessageEmail,
  noticeStatusEmail,
  parseRelayedFrom,
  type EmailContent,
} from "./templates";

type TicketEvents = TicketUpdatedPayload["payload"]["events"];

/** "System note:" detector, shared with helpdesk.ts's requester path (same semantics). */
export const isSystemNoteText = (t?: string): boolean =>
  typeof t === "string" && /(^|\n)\s*System note:/i.test(t);

const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// #region Event classification

export type ClassifiedEvent = { authorId: string | null } & (
  | {
      kind: "message";
      text: string;
      isPrivate: boolean;
      isSystemNote: boolean;
      authorType: string;
      authorName: string | null;
    }
  | { kind: "status"; oldStatus: string; newStatus: string }
  | { kind: "assignment"; newTeam?: string; newAgent?: string }
);

/**
 * Classify the LAST event of a webhook payload — the one the notification is about. Returns null
 * for anything that shouldn't produce a notice: no events, an empty message (attachments-only),
 * a no-op status change (old === new), or an unrecognized event shape.
 */
export function classifyLastEvent(events: TicketEvents | undefined): ClassifiedEvent | null {
  const last = events?.at(-1);
  if (!last) return null;
  const authorId = last.author?.ID ?? null;

  const text = last.message?.text;
  if (typeof text === "string" && text.trim()) {
    return {
      kind: "message",
      authorId,
      text,
      isPrivate: !!last.message?.isPrivate,
      isSystemNote: isSystemNoteText(text),
      authorType: last.author?.type ?? "unknown",
      authorName: last.author?.name ?? null,
    };
  }
  if (last.status) {
    if (last.status.new === last.status.old) return null;
    return {
      kind: "status",
      authorId,
      oldStatus: String(last.status.old ?? ""),
      newStatus: String(last.status.new ?? ""),
    };
  }
  if (last.assignment) {
    return {
      kind: "assignment",
      authorId,
      newTeam: last.assignment.new?.team?.name || undefined,
      newAgent: last.assignment.new?.agent?.name || undefined,
    };
  }
  return null;
}

// #endregion

// #region Recipient extraction (the one defensive parser)

export type NoticeRecipient = {
  email: string; // trimmed + lowercased
  source: "follower" | "cc";
  agentId?: string; // known for followers resolved from an agent ID (used for author exclusion)
};

/**
 * Extract notice recipients from the raw `followers` / `cc` arrays. Defensive against every
 * plausible element shape (see the file header): email strings, {email} objects, and — for
 * followers — agent-ID entries (bare strings or {ID}) resolved through `getAgents`, which is
 * called AT MOST once and only when an ID-shaped entry exists. A failed agent lookup degrades to
 * the email-bearing entries (logged); junk entries are logged and skipped. Deduped by email;
 * an address in both lists keeps the follower source (superset visibility).
 */
export async function extractNoticeRecipients(opts: {
  followers: unknown;
  cc: unknown;
  getAgents: () => Promise<HelpdeskAgent[]>;
  log?: (...args: any[]) => void;
}): Promise<NoticeRecipient[]> {
  const { getAgents, log } = opts;
  const followers = Array.isArray(opts.followers) ? opts.followers : [];
  const cc = Array.isArray(opts.cc) ? opts.cc : [];

  if (followers.length || cc.length) {
    // Raw-shape visibility: the element shapes are unverified against live payloads, so log what
    // actually arrived — this is how the real shape gets confirmed from App Insights.
    log?.("Notices: raw follower/cc arrays", {
      followers: safeJson(followers),
      cc: safeJson(cc),
    });
  }

  // Lazily-memoized agent list: at most one listAgents call per invocation, none when every entry
  // already carries an email.
  let agentsPromise: Promise<HelpdeskAgent[]> | null = null;
  const agentById = async (): Promise<Map<string, HelpdeskAgent>> => {
    agentsPromise ??= getAgents();
    const agents = await agentsPromise;
    return new Map(agents.map((a) => [a.ID, a]));
  };

  const out = new Map<string, NoticeRecipient>();
  const add = (email: string, source: "follower" | "cc", agentId?: string) => {
    const key = email.trim().toLowerCase();
    if (!key || out.has(key)) return; // followers are processed first, so follower wins over cc
    out.set(key, { email: key, source, agentId });
  };

  const handleEntry = async (entry: unknown, source: "follower" | "cc"): Promise<void> => {
    if (typeof entry === "string") {
      if (entry.includes("@")) return add(entry, source);
      if (source === "follower") return resolveAgentId(entry, source);
      log?.("Notices: unrecognized cc entry skipped", { entry: safeJson(entry) });
      return;
    }
    if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const email = typeof rec.email === "string" ? rec.email : null;
      const id = typeof rec.ID === "string" ? rec.ID : typeof rec.id === "string" ? rec.id : null;
      if (email && email.includes("@")) return add(email, source, id ?? undefined);
      if (id && source === "follower") return resolveAgentId(id, source);
    }
    log?.(`Notices: unrecognized ${source} entry skipped`, { entry: safeJson(entry) });
  };

  const resolveAgentId = async (id: string, source: "follower" | "cc"): Promise<void> => {
    try {
      const agent = (await agentById()).get(id);
      if (agent?.email) return add(agent.email, source, id);
      log?.("Notices: follower agent ID not resolvable — skipped", { id });
    } catch (e) {
      // Degrade: email-bearing entries still get notified; only ID entries are lost this run.
      log?.("Notices: agent lookup FAILED — ID-shaped entries skipped", {
        error: formatAxiosError(e),
      });
    }
  };

  for (const f of followers) await handleEntry(f, "follower");
  for (const c of cc) await handleEntry(c, "cc");
  return [...out.values()];
}

// #endregion

// #region Orchestration

/**
 * Send the follower / people-in-the-loop notices for one webhook payload. NEVER throws — the
 * webhook must stay best-effort (a 500 makes Helpdesk retry the delivery, duplicating emails).
 * Per-recipient sends are individually isolated (the alerts.ts pattern).
 */
export async function sendTicketNotices(opts: {
  graph: AxiosInstance;
  helpdesk: AxiosInstance;
  payload: TicketUpdatedPayload;
  mailbox: string; // shared mailbox to send AS (customFields.inbox ?? default, resolved by caller)
  step: StepFn;
  stepError: StepErrorFn;
}): Promise<void> {
  const { graph, helpdesk, payload, mailbox, step, stepError } = opts;
  try {
    const p = payload.payload;

    const event = classifyLastEvent(p.events);
    if (!event) {
      step("Notices: last event not noticeable (empty/no-op/unrecognized) — none sent");
      return;
    }

    const rawFollowers = Array.isArray(p.followers) ? p.followers : [];
    const rawCc = Array.isArray(p.cc) ? p.cc : [];
    if (rawFollowers.length === 0 && rawCc.length === 0) {
      step("Notices: ticket has no followers or people in the loop — none sent");
      return;
    }

    const recipients = await extractNoticeRecipients({
      followers: rawFollowers,
      cc: rawCc,
      getAgents: () => listAgents(helpdesk),
      log: step,
    });

    // Echo control: never notify the requester (their own reply path covers them), the event's
    // author, or the relayed-from sender of a threaded non-requester reply.
    const excluded = new Set(
      [p.requester?.email, p.customFields?.email]
        .map((e) => (e ?? "").trim().toLowerCase())
        .filter(Boolean)
    );
    const markerSender =
      event.kind === "message" && event.authorType !== "agent"
        ? parseRelayedFrom(event.text)
        : null;
    if (markerSender) excluded.add(markerSender);

    const publicVisibility = event.kind === "status" || (event.kind === "message" && !event.isPrivate && !event.isSystemNote);

    const ref = p.shortID || p.ID;
    const content: EmailContent =
      event.kind === "message"
        ? noticeMessageEmail({
            ticketSubject: p.subject,
            shortId: p.shortID,
            ref,
            authorLabel:
              event.authorType === "agent"
                ? event.authorName || "An agent"
                : markerSender || p.requester?.name || "The requester",
            text: event.text,
            isPrivate: event.isPrivate,
            isSystemNote: event.isSystemNote,
          })
        : event.kind === "status"
          ? noticeStatusEmail({
              ticketSubject: p.subject,
              shortId: p.shortID,
              ref,
              oldStatus: event.oldStatus,
              newStatus: event.newStatus,
            })
          : noticeAssignmentEmail({
              ticketSubject: p.subject,
              shortId: p.shortID,
              ref,
              newTeam: event.newTeam,
              newAgent: event.newAgent,
            });

    let sent = 0;
    let suppressed = 0;
    let failed = 0;
    for (const r of recipients) {
      // Visibility ladder: cc (external) recipients only see public events; followers see all.
      if (r.source === "cc" && !publicVisibility) {
        suppressed++;
        continue;
      }
      if (excluded.has(r.email) || (event.authorId && r.agentId === event.authorId)) {
        suppressed++;
        continue;
      }
      if (!emailOk(r.email) || shouldSuppressRecipient(r.email)) {
        suppressed++;
        step("Notices: recipient suppressed (invalid or loop guard)", { to: r.email });
        continue;
      }
      try {
        await sendMailViaGraph({ graph, mailbox, to: r.email, subject: content.subject, body: content.body });
        sent++;
      } catch (e) {
        failed++;
        stepError("Notices: send FAILED (recipient skipped)", e, { to: r.email });
      }
    }
    step("Notices: done", { event: event.kind, recipients: recipients.length, sent, suppressed, failed });
  } catch (e) {
    // Best-effort by contract: a notice failure must never fail the webhook.
    stepError("Notices: pass FAILED (ignored)", e, { ticketId: payload.payload?.ID });
  }
}

// #endregion
