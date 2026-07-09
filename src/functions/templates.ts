// src/functions/templates.ts
// All customer-facing copy the relay produces, in one place so the wording is easy to find and
// edit without touching the orchestration in process-mail / helpdesk:
//   - the auto-reply email sent back to people who reply to an existing ticket (a NEW ticket is
//     opened silently — no "ticket created" notice is sent),
//   - the email that carries an agent's reply,
//   - the ticket message snippets the relay writes (uploaded-attachment list + oversize note).
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
