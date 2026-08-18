// src/functions/reply-mailbox.ts
// Which shared mailbox does outbound WEBHOOK mail go out from?
//
// The problem this solves: a ticket's `customFields.inbox` is stamped once, by process-mail.ts, with
// the mailbox the customer's original email landed in — and it never changes. Tickets are routinely
// reassigned to another team afterwards (Escape -> Escape Referrals / Escape Endorsements), and from
// that moment the recorded inbox is NOT the mailbox the responding team owns: the requester gets an
// agent reply from `escape@`, replies to it, and their reply lands back in the wrong mailbox, away
// from the team that is actually working the ticket.
//
// So the sending mailbox is tied to the ticket's ASSIGNED TEAM at the time of the webhook's event
// (routing.ts's `MAILBOX_BY_TEAM`, the reverse of the inbound `TEAM_BY_INBOX` routing); a team that
// owns no mailbox answers from the Escape mailbox. Pure, no I/O, so it is unit-testable and safe to
// call from both the requester path and the notice fan-out in helpdesk.ts.
//
// Scope: WEBHOOK mail only (agent replies to the requester, follower/cc notices, assigned-agent
// notices). Inbound acks from process-mail.ts deliberately keep answering from the mailbox the
// customer actually wrote to — a reply has to come back from the address it was sent to.
import { hasMonitoredMailboxes, isMonitoredMailbox, mailboxForTeam } from "./routing";

/** Where mail goes when the assigned team owns no mailbox — or there is no assigned team at all. */
export const DEFAULT_REPLY_MAILBOX = "escape@corespecialty.com";

/**
 * The parts of a webhook payload this resolution reads. Deliberately loose/structural (rather than
 * `TicketUpdatedPayload`) so both the create and update payload shapes fit, and so a live payload
 * that omits a field the generated type marks required can't crash the resolution.
 */
export type ReplyMailboxPayload = {
  payload: {
    customFields?: Record<string, string> | null;
    assignment?: { team?: { ID?: string | null; name?: string | null } | null } | null;
    teamIDs?: unknown;
    events?: unknown;
  };
};

export type ReplyMailboxSource = "team" | "inbox" | "default";

export type ReplyMailboxResolution = {
  /** The mailbox to send AS. */
  mailbox: string;
  /** The assigned team the mailbox was derived from (or the one we found but couldn't map). */
  teamId: string | null;
  /** Which rung of the ladder produced `mailbox` — surfaced in the step log. */
  source: ReplyMailboxSource;
  /** Why the assigned team's mailbox was NOT used (absent when `source === "team"`). */
  reason?: string;
};

/** A non-blank trimmed string, or null. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The team the ticket is assigned to as of this webhook's event.
 *
 * Ladder, most to least authoritative:
 *   1. `payload.assignment.team.ID` — the snapshot Helpdesk builds for THIS delivery, so it already
 *      reflects the state at the time of the event (a webhook fired by a reassignment carries the
 *      NEW team here, which is exactly the team that should answer from now on).
 *   2. The most recent assignment event's `assignment.new.team.ID` — scanned from the end of the
 *      history. Covers a payload whose snapshot is missing/blank, and also picks up a same-action
 *      auto-assignment companion event (a reply that assigned the ticket) because the companion sits
 *      at the END of the events array. Deliberately not anchored to `selectActionEvent`: the
 *      assignment recorded closest to the action IS the assignment in force for it.
 *   3. The ticket's `teamIDs`, first entry that owns a mailbox — an unassigned-but-teamed ticket.
 */
export function assignedTeamIdForEvent(payload: ReplyMailboxPayload): string | null {
  const snapshot = text(payload?.payload?.assignment?.team?.ID);
  if (snapshot) return snapshot;

  const rawEvents = payload?.payload?.events;
  const events: Array<Record<string, unknown> | null | undefined> = Array.isArray(rawEvents)
    ? rawEvents
    : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const assignment = events[i]?.assignment as
      | { new?: { team?: { ID?: unknown } | null } | null }
      | undefined;
    const teamId = text(assignment?.new?.team?.ID);
    if (teamId) return teamId;
  }

  const rawTeamIDs = payload?.payload?.teamIDs;
  const teamIDs: unknown[] = Array.isArray(rawTeamIDs) ? rawTeamIDs : [];
  for (const raw of teamIDs) {
    const teamId = text(raw);
    // Only a team we can actually map is worth taking off this rung: `teamIDs` can hold several
    // teams in no meaningful order, so an unmapped first entry must not shadow a mapped sibling.
    if (teamId && mailboxForTeam(teamId)) return teamId;
  }
  return null;
}

/**
 * Can this app actually `sendMail` as `mailbox`? Graph only allows the mailboxes the Exchange
 * Application Access Policy covers, which in practice is `MAILBOX_ADDRESSES`. With nothing
 * configured the question is unanswerable, so we say yes rather than reject everything.
 */
function canSendAs(mailbox: string): boolean {
  return !hasMonitoredMailboxes() || isMonitoredMailbox(mailbox);
}

/**
 * Resolve the mailbox webhook mail for this ticket must be sent AS, and why.
 *
 * Ladder:
 *   1. The assigned team's mailbox (`MAILBOX_BY_TEAM`) — the fix: it follows reassignments.
 *   2. `DEFAULT_REPLY_MAILBOX` (the Escape mailbox) when the assigned team owns no mailbox — Mgmt.,
 *      a brand-new team, or an unassigned ticket. Deliberately NOT `customFields.inbox`: that field
 *      is the stale value this whole module exists to stop trusting, so a team we can't place
 *      answers from the one mailbox that is always staffed rather than from wherever the mail
 *      happened to land months ago.
 *
 * Safety valve on rung 1: a team mailbox outside `MAILBOX_ADDRESSES` (a Production team ID seen by
 * the Development app — the two share one Helpdesk account) would make every send 403 and silently
 * drop the reply. That case alone falls back to `customFields.inbox`, because in that environment
 * the recorded inbox is a mailbox this app demonstrably drains — and only if it too is sendable,
 * otherwise the default.
 */
export function resolveReplyMailbox(payload: ReplyMailboxPayload): ReplyMailboxResolution {
  const teamId = assignedTeamIdForEvent(payload);
  const teamMailbox = mailboxForTeam(teamId);

  if (teamMailbox) {
    if (canSendAs(teamMailbox)) return { mailbox: teamMailbox, teamId, source: "team" };

    const reason = `assigned team's mailbox ${teamMailbox} is not in MAILBOX_ADDRESSES (cannot send as it)`;
    const inbox = text(payload?.payload?.customFields?.inbox);
    if (inbox && canSendAs(inbox)) return { mailbox: inbox, teamId, source: "inbox", reason };
    return { mailbox: DEFAULT_REPLY_MAILBOX, teamId, source: "default", reason };
  }

  return {
    mailbox: DEFAULT_REPLY_MAILBOX,
    teamId,
    source: "default",
    reason: teamId ? `assigned team ${teamId} has no mapped mailbox` : "ticket has no assigned team",
  };
}
