// src/functions/escape-portal.ts
// Escape Portal submission detection. A broker submits an application on the StarStone Escape
// Portal website; the portal emails the referral notification INTO the drain mailbox with the
// mailbox itself as both From and To — the real submitter appears only inside the body, in the
// Producer Information section's "Email ID:" field. Without this detector such a ticket's
// requester is the drain mailbox, so every outbound reply is loop-suppressed and the broker is
// unreachable; with it, the extracted address becomes the effective requester.
//
// Detection is deliberately surgical — EVERY leg must pass or the mail is handled exactly as
// before (requester = the mailbox address it came from):
//   1. From is one of OUR drain mailboxes (MAILBOX_ADDRESSES, alias-domain spellings included);
//   2. From and To are the same address (the portal mails the mailbox to itself);
//   3. the subject is an original — no RE:/FW:/FWD: prefix and no [#shortID] relay tag (either
//      means an existing thread, which a portal submission never is);
//   4. the body carries the portal's signature phrase ("… Escape Portal …");
//   5. the body's "Email ID:" field parses to a plausible email address. A matching template
//      whose Email ID is missing/blank/garbled falls through like every other miss (leg 5 is the
//      payload, not just a gate).
//
// Pure module: no I/O, no Function registration. The only environment dependence is
// MAILBOX_ADDRESSES via routing.ts's isMonitoredMailbox (read fresh per call, like routing.ts).

import type { InboundMessage } from "./graph-mail";
import { isMonitoredMailbox } from "./routing";
import { extractTicketRef } from "./subject";

/** The submitter extracted from a detected Escape Portal notification. */
export type EscapePortalRequester = {
  email: string;
  /** The Producer Information "Contact Name" when present; null when only the email was found. */
  name: string | null;
};

// The portal's self-identification line ("Thank you for submitting this application via the
// StarStone Escape Portal"). Matched loosely on the product name so a branding tweak around it
// (or line wrapping) doesn't silently kill detection; legs 1-3 + the Email ID field keep the
// overall match surgical.
const PORTAL_PHRASE = /escape\s+portal/i;

// Reply/forward subject prefixes (RE:, FW:, FWD:, any case, leading whitespace tolerated).
const REPLY_FORWARD_PREFIX = /^\s*(re|fw|fwd)\s*:/i;

// "Email ID: someone@example.com" — the label tolerates internal whitespace and the template's
// occasional doubled colon (its "Contact Name::" quirk); the value is the first token after it on
// the SAME line ([^\S\r\n] = whitespace-but-not-newline, so an empty field can't swallow the next
// line's first word).
const EMAIL_ID_LINE = /^[ \t>]*email\s*id\s*:{1,2}[^\S\r\n]*(\S+)/im;

// "Contact Name:: Emily Koppang" — the Producer Information name. The template really does emit a
// doubled colon here; accept one or two. Value runs to end of the same line and must not start
// with a colon (else a blank "Contact Name::" backtracks into capturing its own second colon).
const CONTACT_NAME_LINE = /^[ \t>]*contact\s*name\s*:{1,2}[^\S\r\n]*([^:\s].*?)\s*$/im;

// Plausible-address shape: exactly one @, non-empty local part, dotted domain, no whitespace.
// Deliberately loose — Helpdesk validates for real; this only rejects obvious garbage so a mangled
// field falls back to today's behavior instead of creating a ticket with an undeliverable requester.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const an = (a ?? "").trim().toLowerCase();
  const bn = (b ?? "").trim().toLowerCase();
  return !!an && an === bn;
}

/**
 * Detect an Escape Portal submission and extract the real submitter. Returns null unless every
 * detection leg passes AND a plausible "Email ID:" address was found — the caller then treats the
 * result as the effective requester and falls back to the untouched message otherwise.
 */
export function extractEscapePortalRequester(
  parsed: Pick<InboundMessage, "subject" | "fromAddress" | "toAddress" | "text">
): EscapePortalRequester | null {
  if (!isMonitoredMailbox(parsed.fromAddress)) return null;
  if (!sameAddress(parsed.fromAddress, parsed.toAddress)) return null;
  if (REPLY_FORWARD_PREFIX.test(parsed.subject ?? "")) return null;
  if (extractTicketRef(parsed.subject)) return null;
  if (!PORTAL_PHRASE.test(parsed.text ?? "")) return null;

  const emailMatch = EMAIL_ID_LINE.exec(parsed.text ?? "");
  if (!emailMatch) return null;
  // Strip a trailing punctuation straggler (e.g. a sentence period or a mailto:-style wrapper is
  // NOT expected in the plain-text body, but a trailing "." or "," costs nothing to drop).
  const email = emailMatch[1].replace(/[.,;]+$/, "").trim();
  if (!EMAIL_SHAPE.test(email)) return null;

  const nameMatch = CONTACT_NAME_LINE.exec(parsed.text ?? "");
  const name = nameMatch?.[1]?.trim() || null;

  return { email, name };
}
