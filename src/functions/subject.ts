// src/functions/subject.ts
// Helpers for sturdy email threading via an embedded ticket reference: "[#<shortID>]".
//
// Inbound matching prefers this tag over fragile subject-substring comparison, so
// outbound mail (auto-reply, agent replies) embeds the tag and inbound mail reads it.

const TICKET_REF_PATTERN = "\\[#\\s*([A-Za-z0-9._-]+)\\s*\\]";

// A leading run of one or more reply/forward prefixes — "Re:", "RE:", "Fwd:", "FW:", "FWD:", an
// optional Outlook counter like "Re[2]:", any casing/spacing. collapseReplyPrefixes flattens the
// whole run to a single canonical "Re:" so subjects don't stack prefixes across reply round-trips.
const REPLY_PREFIX_RUN = /^(?:\s*(?:re|fwd|fw)(?:\[\d+\])?\s*:\s*)+/i;

/**
 * Collapse a leading run of reply/forward prefixes to a single "Re: ". Subjects with no leading
 * prefix (e.g. "Ticket has been created: …", "Review: budget") are returned unchanged.
 */
function collapseReplyPrefixes(subject: string): string {
  const stripped = subject.replace(REPLY_PREFIX_RUN, "");
  if (stripped === subject) return subject;
  return stripped ? `Re: ${stripped}` : "Re:";
}

/**
 * Extract the ticket shortID embedded as "[#<shortID>]" in a subject.
 * Returns the last reference found (handles forwarded chains), or null.
 */
export function extractTicketRef(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const re = new RegExp(TICKET_REF_PATTERN, "g");
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(subject)) !== null) {
    last = match[1] ?? last;
  }
  return last ? last.trim() : null;
}

/**
 * Return the subject with a clean "[#<shortID>]" reference appended.
 * Any pre-existing reference tags are stripped first, and a leading run of reply/forward prefixes
 * ("Re:", "RE:", "Fwd:", …) is collapsed to a single "Re:", so neither tags nor prefixes accumulate
 * across reply round-trips. If no shortID is available, the subject is returned untagged (threading
 * falls back to subject matching).
 */
export function withTicketRef(
  subject: string | null | undefined,
  shortId: string | null | undefined
): string {
  const re = new RegExp(TICKET_REF_PATTERN, "g");
  const base = collapseReplyPrefixes(
    (subject ?? "")
      .replace(re, "")
      .replace(/\s+/g, " ")
      .trim()
  );
  const ref = (shortId ?? "").trim();
  return ref ? `${base} [#${ref}]` : base;
}

/**
 * Normalize a shortID/reference for comparison.
 */
export function normalizeRef(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}
