// src/functions/routing.ts
// Inbox → team routing and the inbound loop guard. Pure helpers, no I/O.

// Map normalized inbox -> Helpdesk team ID.
const TEAM_BY_INBOX: Record<string, string> = {
  "ingestion@core-parser-01-dev@corespecialty.com": "61ed7601-b6e3-43c2-936a-7afe45e4e246", // Just for Dev and testing.
  "ureferrals@corespecialty.com": "61ed7601-b6e3-43c2-936a-7afe45e4e246", // Official Dev mailbox for Escape.
  "escape@corespecialty.com": "3db812da-2055-436f-9889-7073b5e976f4",
  "escapereferrals@corespecialty.com": "3a5e9d73-e5a0-442e-888b-6573672c9d05",
  "escapeendorsements@corespecialty.com": "c4e7bc52-0c7a-43fb-aa46-0d69f533ee2b",
};

// If we don't know which team, Escape.
const DEFAULT_TEAM_ID = TEAM_BY_INBOX["escape@corespecialty.com"];

// Senders that should never generate tickets (loops / system senders).
const IGNORED_SENDER_PATTERNS = ["helpdesk.com", "corespecialty.onmicrosoft.com"];

// Bounce/NDR senders (matched on the exact local part): a bounce landing in a drained inbox must
// never open a ticket — a second bounce could subject-match the first ticket and trigger an ack,
// and an ack that itself bounces would ping-pong with the remote MTA indefinitely.
const BOUNCE_SENDER_LOCAL_PARTS = ["postmaster", "mailer-daemon"];

// Our mailboxes all live under one UPN domain. The same mailbox is frequently *addressed* on an
// alias domain (e.g. ureferrals@corespecialtyins.com is really ureferrals@corespecialty.com), and
// Microsoft Graph's /users/{id} only resolves the UPN form — not the alias. So everything that needs
// a stable per-mailbox identity (routing key, drain-lock key) collapses to "<local>@corespecialty.com".
const PRIMARY_MAILBOX_DOMAIN = "corespecialty.com";

/**
 * Normalize an inbound "to" address into a deterministic routing key.
 */
export function normalizeInbox(rawTo: string | null | undefined): string {
  if (!rawTo) return `unknown@${PRIMARY_MAILBOX_DOMAIN}`;
  const local = rawTo.split("@")[0] ?? "unknown";
  return `${local}@${PRIMARY_MAILBOX_DOMAIN}`;
}

/**
 * Canonicalize one of OUR mailbox identifiers to its UPN form "<local>@corespecialty.com"
 * (lowercased). Used as the drain-lock key so a notify-triggered drain and a sweep-triggered drain of
 * the same mailbox — which can arrive on different alias domains (or as a GUID vs an email) — collide
 * on one lease. Only meaningful for an email address; a GUID/object id must be resolved to its UPN via
 * Graph first, then passed through here so the two paths land on the identical key.
 */
export function normalizeMailboxKey(address: string): string {
  // Local part up to the first "+": collapse Exchange/O365 plus-subaddressing so an alias spelling
  // like `escape+tag@…` maps to the same key as `escape@…` (it routes to the same mailbox) and can't
  // slip past the loop guard. A "+"-bearing form never appears as a real mailbox identifier, so this
  // is a no-op for the drain-lock key.
  const local = (address.split("@")[0] ?? "").trim().toLowerCase().split("+")[0];
  return `${local}@${PRIMARY_MAILBOX_DOMAIN}`;
}

/**
 * Resolve a Helpdesk team ID from the normalized inbox address.
 */
export function routeTeam(normalizedInbox: string): string {
  return TEAM_BY_INBOX[normalizedInbox] ?? DEFAULT_TEAM_ID;
}

/**
 * Suppress processing for senders that should never generate tickets (loops / system senders /
 * bounces). Two checks:
 *   1. Domain patterns — matched on the part after the last "@", exact or as a dot-suffix for
 *      subdomains — NOT a loose substring — so a lookalike like `x@foohelpdesk.com`,
 *      `x@helpdesk.com.evil.test`, or a pattern sitting in the local part (`helpdesk.com@gmail.com`)
 *      is not treated as an ignored sender.
 *   2. Bounce senders — the exact local part is `postmaster`/`mailer-daemon` (any domain). Exact
 *      match only, so a person like `postmaster.smith@example.com` still gets a ticket.
 */
export function shouldIgnoreSender(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at < 0) return false;
  const domain = address.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  const local = address.slice(0, at).trim().toLowerCase();
  if (BOUNCE_SENDER_LOCAL_PARTS.includes(local)) return true;
  return IGNORED_SENDER_PATTERNS.some(
    (pattern) => domain === pattern || domain.endsWith(`.${pattern}`)
  );
}

// Company domains the relay's drain mailboxes live on. Used ONLY to recognize an alias-domain
// spelling of a drain mailbox: a recipient whose local part matches a MAILBOX_ADDRESSES mailbox AND
// whose domain is one of these (e.g. MAILBOX_ADDRESSES lists escape@corespecialtyins.com, but the
// same mailbox is also escape@corespecialty.com on the UPN domain). This does NOT blanket-block the
// domain — ordinary internal senders (a person@corespecialty.com) still receive replies. Override
// with RELAY_IN_SCOPE_DOMAINS (comma-sep).
const DEFAULT_IN_SCOPE_DOMAINS = ["corespecialty.com", "corespecialtyins.com"];

function inScopeDomains(): string[] {
  const raw = (process.env.RELAY_IN_SCOPE_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return raw.length ? raw : DEFAULT_IN_SCOPE_DOMAINS;
}

/**
 * The shared mailboxes the relay pulls mail FROM (MAILBOX_ADDRESSES), lowercased for exact-match
 * comparison. Parsed fresh each call (cheap) so config changes are picked up. Mirrors
 * subscriptions.ts `mailboxList`, kept local so routing stays pure (no Graph/client imports).
 */
function monitoredMailboxAddresses(): string[] {
  return (process.env.MAILBOX_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether the relay must NOT send to `address` — sending would loop mail back into a drained inbox
 * (re-ingested as a new inbound → ticket → ack → …). The outbound counterpart to
 * `shouldIgnoreSender`. Suppresses, in order:
 *   1. system/loop addresses we'd never reply to anyway (`helpdesk.com`, the `onmicrosoft.com`
 *      tenant, `postmaster`/`mailer-daemon` bounce senders) — reuses `shouldIgnoreSender`;
 *   2. one of OUR drain mailboxes (`MAILBOX_ADDRESSES`) — by exact match (any domain), OR by
 *      canonical mailbox key so the SAME mailbox addressed under an alias company domain is also
 *      caught (e.g. `MAILBOX_ADDRESSES` lists `escape@corespecialtyins.com` but the mailbox is also
 *      `escape@corespecialty.com`). The canonical match is gated to in-scope company domains so an
 *      external recipient that merely shares a local part (`escape@gmail.com`) is NOT suppressed.
 * It deliberately does NOT blanket-suppress every company-domain address: ordinary internal senders
 * (a `person@corespecialty.com`) DO get replies. Only the relay's own drain mailboxes are protected
 * from a reply loop — so a drain mailbox reachable only under a different-local-part proxy alias must
 * be listed explicitly in `MAILBOX_ADDRESSES`. Domains are matched on the part after the last `@`
 * (exact or dot-suffix), not a loose substring, so a lookalike like `notcorespecialty.com.evil.test`
 * is not treated as in-scope.
 */
export function shouldSuppressRecipient(address: string | null | undefined): boolean {
  const a = (address ?? "").trim().toLowerCase();
  if (!a) return false;
  if (shouldIgnoreSender(a)) return true;

  const monitored = monitoredMailboxAddresses();
  if (monitored.includes(a)) return true; // exact configured mailbox (on any domain)

  // Catch the same drain mailbox addressed under an alias company domain (the UPN-domain spelling
  // isn't necessarily the form enumerated in MAILBOX_ADDRESSES). Only within in-scope company
  // domains, and only when the canonical mailbox key matches a configured mailbox — so non-mailbox
  // internal addresses and same-local-part external addresses are left alone (they get replies).
  const domain = a.split("@").pop() ?? "";
  const onInScopeDomain = inScopeDomains().some((d) => domain === d || domain.endsWith(`.${d}`));
  if (onInScopeDomain) {
    const monitoredKeys = new Set(monitored.map(normalizeMailboxKey));
    if (monitoredKeys.has(normalizeMailboxKey(a))) return true;
  }
  return false;
}
