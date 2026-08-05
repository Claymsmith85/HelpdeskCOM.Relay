// src/functions/templates.ts
// All customer-facing copy the relay produces, in one place so the wording is easy to find and
// edit without touching the orchestration in process-mail / helpdesk:
//   - the auto-reply email sent back to people who reply to an existing ticket (a NEW ticket is
//     opened silently — no "ticket created" notice is sent),
//   - the email that carries an agent's reply,
//   - the ticket message snippets the relay writes (uploaded-attachment list + oversize note),
//   - the follower / people-in-the-loop notice emails (ticket-notices.ts), plus the
//     "[Relayed from …]" marker pair — builder AND parser live here together so they can't drift.
// Pure string-building — no I/O — so it is freely importable and unit-testable. Outbound subjects
// are threaded with the "[#shortID]" tag via subject.ts so replies match back to their ticket.
import { withTicketRef } from "./subject";
import type { AttachmentMeta } from "./graph-mail";

/** Subject + body for an outbound email. */
export type EmailContent = { subject: string; body: string };

/**
 * Auto-reply sent to the customer when their email updates an EXISTING ticket.
 *
 * Note: there is intentionally no new-ticket auto-reply — opening a ticket sends the requester no
 * "ticket has been created" notice (from the relay or from Helpdesk).
 */
export function existingTicketAutoReply(opts: {
  inboundSubject: string;
  shortId: string | null | undefined;
  ticketId: string;
}): EmailContent {
  const { inboundSubject, shortId, ticketId } = opts;
  const ref = shortId ?? ticketId;
  return {
    subject: withTicketRef(`Re: ${inboundSubject}`, shortId),
    body: `We've received your reply and updated ticket ${ref}.`,
  };
}

/**
 * Email that delivers an agent's reply to the customer. The body is the agent's own message text,
 * unchanged; only the threaded subject is templated here.
 */
export function agentReplyEmail(opts: {
  inboundSubject: string;
  shortId: string | null | undefined;
  body: string;
}): EmailContent {
  const { inboundSubject, shortId, body } = opts;
  return {
    subject: withTicketRef(`Re: ${inboundSubject}`, shortId),
    body,
  };
}

/**
 * Append the SharePoint folder link and uploaded attachment filenames to a ticket message body.
 * Returns the base text unchanged when there is nothing to add.
 */
export function appendFolderAndFilenamesToBody(
  baseText: string,
  filenames: string[],
  folderWebUrl?: string
): string {
  if ((!filenames || filenames.length === 0) && !folderWebUrl) return baseText;

  const lines: string[] = [""];
  if (folderWebUrl) lines.push("Ticket folder:", folderWebUrl, "");
  lines.push("Attachments received:");
  if (filenames && filenames.length > 0) {
    for (const name of filenames) lines.push(`- ${name}`);
  } else {
    lines.push("(none)");
  }
  return `${baseText}\n${lines.join("\n")}`;
}

/**
 * Build the agent "System note" ticket comment naming the attachments that exceeded the per-file
 * size limit and were skipped. In-limit files in the same message still upload.
 */
export function buildOversizeCommentText(opts: {
  blocked: AttachmentMeta[];
  maxBytesPerFile: number;
}): string {
  const { blocked, maxBytesPerFile } = opts;

  const lines = [
    "System note:",
    `The following attachment(s) exceeded the ${formatMiB(
      maxBytesPerFile
    )} MiB per-file limit and were not uploaded:`,
  ];
  for (const f of blocked) lines.push(`- ${f.filename} (${formatMiB(f.size)} MiB)`);
  lines.push("The original email and its attachments remain in the mailbox.");
  return lines.join("\n");
}

/** Convert bytes to a mebibytes string for messaging. */
function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

// ---- Follower / people-in-the-loop notices (consumed by ticket-notices.ts) ----

/**
 * First line the inbound worker prefixes onto a ticket message that a NON-requester (a follower or
 * person-in-the-loop) threaded in by replying to a notice. Two jobs: attribute the message in the
 * Helpdesk UI (the API author is a generic "client"), and let the webhook's notice pass exclude
 * the sender from the notice about their own message (parseRelayedFrom below).
 */
export function relayedFromMarker(email: string): string {
  return `[Relayed from ${email.trim()}]`;
}

const RELAYED_FROM_RE = /^\[Relayed from ([^\s\]]+@[^\s\]]+)\]\s*$/;

/**
 * Parse the relayed-from marker off a ticket message's FIRST line only (a marker quoted deeper in
 * a reply chain must not count). Returns the lowercased email, or null when the text doesn't start
 * with a marker.
 */
export function parseRelayedFrom(text: string | null | undefined): string | null {
  const firstLine = (text ?? "").split("\n", 1)[0] ?? "";
  const m = RELAYED_FROM_RE.exec(firstLine.trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * Neutralize a FORGED marker on an inbound body the relay did NOT relay: the marker is trusted
 * attribution (the notice pass reads it as "who really wrote this" and excludes that address from
 * its own notice), so a customer starting their reply with a hand-typed marker could impersonate
 * someone in the notices AND surgically suppress that person's copy. Prefixing a newline moves the
 * forged line off line 1, where parseRelayedFrom refuses to look. Genuine relayed appends are
 * built AFTER this runs (real marker + blank line + body), so they are unaffected.
 */
export function neutralizeForgedMarker(text: string): string {
  return parseRelayedFrom(text) ? `\n${text}` : text;
}

/**
 * Notice for a message event on a ticket (agent reply, customer reply, private note, system note).
 * The subject is threaded so a recipient's reply matches back into the SAME ticket (the inbound
 * worker threads tagged non-requester replies when NOTICES_TOGGLE is on).
 */
export function noticeMessageEmail(opts: {
  ticketSubject: string;
  shortId: string | null | undefined;
  ref: string;
  authorLabel: string; // who wrote it — agent name, relayed-from email, or the requester's name
  text: string;
  isPrivate: boolean;
  isSystemNote: boolean;
}): EmailContent {
  const { ticketSubject, shortId, ref, authorLabel, text, isPrivate, isSystemNote } = opts;
  const kind = isSystemNote ? "system note" : isPrivate ? "private note" : "reply";
  return {
    subject: withTicketRef(`Re: ${ticketSubject}`, shortId),
    body: `${authorLabel} added a ${kind} to ticket ${ref}:\n\n${text}`,
  };
}

/** Notice for a ticket status change. */
export function noticeStatusEmail(opts: {
  ticketSubject: string;
  shortId: string | null | undefined;
  ref: string;
  oldStatus: string;
  newStatus: string;
}): EmailContent {
  const { ticketSubject, shortId, ref, oldStatus, newStatus } = opts;
  return {
    subject: withTicketRef(`Re: ${ticketSubject}`, shortId),
    body: `Ticket ${ref} status changed: ${oldStatus} -> ${newStatus}.`,
  };
}

/**
 * Notice for a change to the ticket's audience lists — the `cc` ("people in the loop") and
 * `followers` event types. For a loop change this is also the "you've been added" welcome: a newly
 * added person is already on the ticket's cc list when the event fires, so they receive it.
 */
export function noticeAudienceChangeEmail(opts: {
  ticketSubject: string;
  shortId: string | null | undefined;
  ref: string;
  what: "people in the loop" | "followers";
  added: string[]; // emails (cc) or agent names (followers)
  removed: string[];
}): EmailContent {
  const { ticketSubject, shortId, ref, what, added, removed } = opts;
  const bits = [
    added.length ? `added: ${added.join(", ")}` : "",
    removed.length ? `removed: ${removed.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return {
    subject: withTicketRef(`Re: ${ticketSubject}`, shortId),
    body: `The ${what} on ticket ${ref} changed — ${bits}.`,
  };
}

/** Notice for a ticket assignment change (followers only — names internal agents/teams). */
export function noticeAssignmentEmail(opts: {
  ticketSubject: string;
  shortId: string | null | undefined;
  ref: string;
  newTeam?: string;
  newAgent?: string;
}): EmailContent {
  const { ticketSubject, shortId, ref, newTeam, newAgent } = opts;
  const team = newTeam || "unassigned";
  const agent = newAgent || "unassigned";
  return {
    subject: withTicketRef(`Re: ${ticketSubject}`, shortId),
    body: `Ticket ${ref} was reassigned — team: ${team}, agent: ${agent}.`,
  };
}
