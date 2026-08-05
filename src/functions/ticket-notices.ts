// src/functions/ticket-notices.ts
// Ticket-event notice emails (no Function registration — the thin call lives in helpdesk.ts, the
// templates in templates.ts). Helpdesk's native notifications are FULLY disabled (requester and
// agent alike; see CLAUDE.md invariant #2), so without this a ticket's followers
// (`payload.followers`, agents), people-in-the-loop (`payload.cc`, external emails), and assigned
// agent hear nothing when a ticket changes. Audience flags are passed explicitly by the caller so
// this module stays freely testable and never reads feature-toggle environment variables.
//
// Per-audience visibility (decided with the business):
//   - FOLLOWERS (internal agents): every classified event — public messages, private notes,
//     "System note:" texts, status changes, assignment changes.
//   - PEOPLE IN THE LOOP (external): public messages and status changes ONLY — never private or
//     system notes, and never assignment changes (they name internal agents/teams).
//   - ASSIGNED AGENT: public messages ONLY, including messages authored by that same agent. These
//     are copies of the ticket's emails, not general ticket-change notifications.
//
// Echo control for followers / people in the loop: the requester (they have their own reply path),
// the event's author, and the relayed-from sender (a non-requester whose reply the inbound worker
// threaded — see templates.ts's marker pair) are excluded. The assigned-agent audience deliberately
// does NOT apply the requester/author exclusions: the agent receives their own Helpdesk-authored
// public replies, and an agent whose address equals the requester may receive both independently-
// routed copies. It DOES suppress an assigned agent who is the relayed-from sender: otherwise an
// out-of-office reply can thread back, be copied to the same agent, and ping-pong forever. Every
// recipient in every audience still passes shouldSuppressRecipient so a notice can never land in
// a drain mailbox and open a ticket. If an address is in both notice audiences, one copy is sent
// under the assigned-agent rules.
//
// Field shapes (confirmed 2026-08-04 against a live ticket read): `followers` is bare agent-ID
// strings ["<guid>"]; `cc` is [{ email, name|null }] objects. extractNoticeRecipients still parses
// defensively (email strings, {email} objects, {ID}/bare-ID entries resolved via listAgents) —
// the confirmation came from the REST read, and keeping the other branches costs nothing if the
// webhook body ever differs — and logs the raw arrays whenever non-empty for App Insights.
import { AxiosInstance } from "axios";
import { TicketUpdatedPayload } from "../types/TicketUpdatePayload";
import { sendMailViaGraph } from "./graph-mail";
import { HelpdeskAgent, listAgents } from "./helpdesk-client";
import { shouldSuppressRecipient } from "./routing";
import { formatAxiosError, safeJson, type StepFn, type StepErrorFn } from "./logging";
import {
  noticeAssignmentEmail,
  noticeAudienceChangeEmail,
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

export type ClassifiedEvent = { authorId: string | null; authorEmail: string | null } & (
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
  // The `cc` / `followers` event types (people-in-the-loop / follower list edited): `added` /
  // `removed` are the {new}-vs-{old} diff — emails for cc, agent names for followers.
  | { kind: "cc"; added: string[]; removed: string[] }
  | { kind: "followers"; added: string[]; removed: string[] }
);

/**
 * Classify the LAST event of a webhook payload — the one the notification is about. Returns null
 * for anything that shouldn't produce a notice: no events, an empty message (attachments-only),
 * a no-op status or audience change, or an unrecognized event shape.
 */
export function classifyLastEvent(events: TicketEvents | undefined): ClassifiedEvent | null {
  const last = events?.at(-1);
  if (!last) return null;
  const authorId = last.author?.ID ?? null;
  // Client-authored events carry the author's email (live payloads; the generated type lags) —
  // surfaced for echo control, so the author of a customer/loop reply never gets self-noticed.
  const rawAuthorEmail = (last.author as { email?: unknown } | undefined)?.email;
  const authorEmail =
    typeof rawAuthorEmail === "string" && rawAuthorEmail.trim()
      ? rawAuthorEmail.trim().toLowerCase()
      : null;

  const text = last.message?.text;
  if (typeof text === "string" && text.trim()) {
    return {
      kind: "message",
      authorId,
      authorEmail,
      text,
      isPrivate: !!last.message?.isPrivate,
      // Anchored to the FIRST line: an event IS a system note only when it starts as one. (The
      // requester gate's isSystemNoteText stays any-line deliberately — conservative about
      // emailing a customer a message that merely QUOTES a note; here any-line would mislabel a
      // genuine public reply and silently hide it from every person-in-the-loop.)
      isSystemNote: /^\s*System note:/i.test(text),
      authorType: last.author?.type ?? "unknown",
      authorName: last.author?.name ?? null,
    };
  }
  if (last.status) {
    if (last.status.new === last.status.old) return null;
    return {
      kind: "status",
      authorId,
      authorEmail,
      oldStatus: String(last.status.old ?? ""),
      newStatus: String(last.status.new ?? ""),
    };
  }
  if (last.assignment) {
    return {
      kind: "assignment",
      authorId,
      authorEmail,
      newTeam: last.assignment.new?.team?.name || undefined,
      newAgent: last.assignment.new?.agent?.name || undefined,
    };
  }

  // `cc` / `followers` events aren't in the generated Event type (they were discovered on a live
  // ticket), hence the casts. cc entries diff by email; follower entries ({ID, name} here, unlike
  // the ticket-level bare IDs) diff by ID and render by name.
  const ccChange = (last as { cc?: { new?: unknown; old?: unknown } }).cc;
  if (ccChange && (Array.isArray(ccChange.new) || Array.isArray(ccChange.old))) {
    const emails = (v: unknown): string[] =>
      (Array.isArray(v) ? v : [])
        .map((e: any) => (typeof e === "string" ? e : e?.email))
        .filter((e: any): e is string => typeof e === "string" && !!e.trim())
        .map((e) => e.trim().toLowerCase());
    const before = new Set(emails(ccChange.old));
    const after = new Set(emails(ccChange.new));
    const added = [...after].filter((e) => !before.has(e));
    const removed = [...before].filter((e) => !after.has(e));
    if (!added.length && !removed.length) return null;
    return { kind: "cc", authorId, authorEmail, added, removed };
  }
  const folChange = (last as { followers?: { new?: unknown; old?: unknown } }).followers;
  if (folChange && (Array.isArray(folChange.new) || Array.isArray(folChange.old))) {
    const entries = (v: unknown): { id: string; label: string }[] =>
      (Array.isArray(v) ? v : [])
        .map((f: any) =>
          typeof f === "string"
            ? { id: f, label: f }
            : { id: String(f?.ID ?? ""), label: String(f?.name || f?.ID || "") }
        )
        .filter((f) => f.id);
    const before = entries(folChange.old);
    const after = entries(folChange.new);
    const beforeIds = new Set(before.map((f) => f.id));
    const afterIds = new Set(after.map((f) => f.id));
    const added = after.filter((f) => !beforeIds.has(f.id)).map((f) => f.label);
    const removed = before.filter((f) => !afterIds.has(f.id)).map((f) => f.label);
    if (!added.length && !removed.length) return null;
    return { kind: "followers", authorId, authorEmail, added, removed };
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
 * Send the enabled notice audiences for one webhook payload. NEVER throws — the webhook must
 * stay best-effort (a 500 makes Helpdesk retry the delivery, duplicating emails). Per-recipient
 * sends are individually isolated (the alerts.ts pattern).
 */
export async function sendTicketNotices(opts: {
  graph: AxiosInstance;
  helpdesk: AxiosInstance;
  payload: TicketUpdatedPayload;
  mailbox: string; // shared mailbox to send AS (customFields.inbox ?? default, resolved by caller)
  followers: boolean;
  agent: boolean;
  step: StepFn;
  stepError: StepErrorFn;
}): Promise<void> {
  const {
    graph,
    helpdesk,
    payload,
    mailbox,
    followers: followersEnabled,
    agent: agentEnabled,
    step,
    stepError,
  } = opts;
  try {
    if (!followersEnabled && !agentEnabled) {
      step("Notices: no audiences enabled — none sent");
      return;
    }

    const p = payload.payload;
    const event = classifyLastEvent(p.events);
    if (!event) {
      step("Notices: last event not noticeable (empty/no-op/unrecognized) — none sent");
      return;
    }

    // Shared lazily-memoized agent list: one listAgents call at most, reused by the follower
    // extractor, follower author-email exclusion, and assigned-agent resolution.
    let agentsPromise: Promise<HelpdeskAgent[]> | null = null;
    const getAgents = () => (agentsPromise ??= listAgents(helpdesk));

    const rawFollowers = Array.isArray(p.followers) ? p.followers : [];
    const rawCc = Array.isArray(p.cc) ? p.cc : [];
    let recipients: NoticeRecipient[] = [];
    if (followersEnabled) {
      if (rawFollowers.length === 0 && rawCc.length === 0) {
        step("Notices: ticket has no followers or people in the loop — follower audience empty");
      } else {
        recipients = await extractNoticeRecipients({
          followers: rawFollowers,
          cc: rawCc,
          getAgents,
          log: step,
        });
      }
    }

    // The assigned agent receives public messages only. Resolve them before sending follower/cc
    // notices so a shared address can be removed from that pass: assigned-agent rules win the
    // cross-audience dedupe, including the deliberate include-own-replies behavior.
    const agentEventEligible =
      agentEnabled &&
      event.kind === "message" &&
      !event.isPrivate &&
      !event.isSystemNote;
    let assignedAgentEmail: string | null = null;
    if (agentEnabled && !agentEventEligible) {
      step("Notices: event not a public message — assigned agent skipped", { event: event.kind });
    } else if (agentEventEligible) {
      const assignedAgentId = p.assignment?.agent?.ID;
      if (!assignedAgentId) {
        step("Notices: ticket has no assigned agent — assigned agent skipped");
      } else {
        try {
          const assigned = (await getAgents()).find((a) => a.ID === assignedAgentId);
          const email = (assigned?.email ?? "").trim().toLowerCase();
          if (email) {
            assignedAgentEmail = email;
          } else {
            step("Notices: assigned agent ID not resolvable — skipped", {
              id: assignedAgentId,
            });
          }
        } catch (e) {
          step("Notices: assigned agent lookup FAILED — skipped", {
            error: formatAxiosError(e),
          });
        }
      }
    }

    // Follower/cc echo control: never notify the requester (their own reply path covers them), the
    // event's author (by agent ID and by email when present), or the relayed-from sender of a
    // threaded non-requester reply. Requester/author exclusions do not apply to the agent audience;
    // the same-address marker-sender loop guard is applied separately at its send below.
    const excluded = new Set<string>();
    if (followersEnabled) {
      for (const email of [p.requester?.email, p.customFields?.email, event.authorEmail]) {
        const normalized = (email ?? "").trim().toLowerCase();
        if (normalized) excluded.add(normalized);
      }
      // An AGENT author's own address may sit in the cc list, where entries carry no agent ID —
      // the agentId leg of the exclusion can't see them (agent events carry no author.email
      // either). Map the authoring agent to their email, sharing the lazy lookup above.
      if (event.authorId && recipients.some((r) => !r.agentId)) {
        try {
          const author = (await getAgents()).find((a) => a.ID === event.authorId);
          const email = (author?.email ?? "").trim().toLowerCase();
          if (email) excluded.add(email);
        } catch (e) {
          step("Notices: author email lookup failed (agent-ID exclusion still applies)", {
            error: formatAxiosError(e),
          });
        }
      }
    }

    const markerSender =
      event.kind === "message" && event.authorType !== "agent"
        ? parseRelayedFrom(event.text)
        : null;
    if (followersEnabled && markerSender) excluded.add(markerSender);

    // What external (cc) recipients may see: public messages, status changes, and loop-list
    // changes (which double as the "you've been added" welcome — a newly added person is already
    // on the cc list when the event fires). Private/system notes, assignment changes, and
    // follower-list changes name internal people/notes and stay follower-only.
    const publicVisibility =
      event.kind === "status" ||
      event.kind === "cc" ||
      (event.kind === "message" && !event.isPrivate && !event.isSystemNote);

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
          : event.kind === "assignment"
            ? noticeAssignmentEmail({
                ticketSubject: p.subject,
                shortId: p.shortID,
                ref,
                newTeam: event.newTeam,
                newAgent: event.newAgent,
              })
            : noticeAudienceChangeEmail({
                ticketSubject: p.subject,
                shortId: p.shortID,
                ref,
                what: event.kind === "cc" ? "people in the loop" : "followers",
                added: event.added,
                removed: event.removed,
              });

    const followers = { recipients: recipients.length, sent: 0, suppressed: 0, failed: 0 };
    const agent = {
      recipients: assignedAgentEmail ? 1 : 0,
      sent: 0,
      suppressed: 0,
      failed: 0,
    };

    for (const r of recipients) {
      // Visibility ladder: cc (external) recipients only see public events; followers see all.
      if (r.source === "cc" && !publicVisibility) {
        followers.suppressed++;
        continue;
      }
      if (excluded.has(r.email) || (event.authorId && r.agentId === event.authorId)) {
        followers.suppressed++;
        continue;
      }
      if (assignedAgentEmail === r.email) {
        followers.suppressed++;
        continue;
      }
      if (!emailOk(r.email) || shouldSuppressRecipient(r.email)) {
        followers.suppressed++;
        step("Notices: recipient suppressed (invalid or loop guard)", {
          audience: "followers",
          to: r.email,
        });
        continue;
      }
      try {
        await sendMailViaGraph({
          graph,
          mailbox,
          to: r.email,
          subject: content.subject,
          body: content.body,
        });
        followers.sent++;
      } catch (e) {
        followers.failed++;
        stepError("Notices: send FAILED (recipient skipped)", e, {
          audience: "followers",
          to: r.email,
        });
      }
    }

    if (assignedAgentEmail) {
      if (markerSender === assignedAgentEmail) {
        agent.suppressed++;
        step("Notices: assigned agent is the relayed-from sender — skipped (auto-responder loop guard)", {
          audience: "agent",
          to: assignedAgentEmail,
        });
      } else if (!emailOk(assignedAgentEmail) || shouldSuppressRecipient(assignedAgentEmail)) {
        agent.suppressed++;
        step("Notices: recipient suppressed (invalid or loop guard)", {
          audience: "agent",
          to: assignedAgentEmail,
        });
      } else {
        try {
          await sendMailViaGraph({
            graph,
            mailbox,
            to: assignedAgentEmail,
            subject: content.subject,
            body: content.body,
          });
          agent.sent++;
        } catch (e) {
          agent.failed++;
          stepError("Notices: send FAILED (recipient skipped)", e, {
            audience: "agent",
            to: assignedAgentEmail,
          });
        }
      }
    }

    step("Notices: done", {
      event: event.kind,
      recipients: followers.recipients + agent.recipients,
      sent: followers.sent + agent.sent,
      suppressed: followers.suppressed + agent.suppressed,
      failed: followers.failed + agent.failed,
      followers,
      agent,
    });
  } catch (e) {
    // Best-effort by contract: a notice failure must never fail the webhook.
    stepError("Notices: pass FAILED (ignored)", e, { ticketId: payload.payload?.ID });
  }
}

// #endregion
