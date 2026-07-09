// src/functions/requester-hash.ts
// The requester-hash round-trip — kept in ONE file so the encode/decode invariant stays in
// sync. Helpdesk stores the requester as "<local>=<domain>@<hashDomain>" so Helpdesk's own
// notifications never reach the real customer (the relay is the sole outbound path); inbound
// processing decodes it back. See README "Subject Threading & Requester Encoding".
import { requireEnv } from "./env";

/**
 * Sink domain the requester is hashed into, from `RELAY_HASH_DOMAIN`. REQUIRED — there is
 * intentionally no hardcoded default: any built-in default would have to be some environment's real
 * sink domain, so a missing/empty var would silently route another environment's requesters through
 * it (and pollute that environment's Helpdesk bounce counter). The value is environment-scoped (a
 * per-environment GitHub Actions variable, surfaced as the `RELAY_HASH_DOMAIN` app setting). Keep it
 * stable so already-created tickets keep decoding; it should be a domain with no real mailbox.
 */
export function hashDomain(): string {
  return requireEnv("RELAY_HASH_DOMAIN");
}

/**
 * Encode a real email into the inbound-hashed requester form.
 * Reversible and subdomain-safe: the single "@" becomes "=" (valid in a local part, never
 * present in a domain), so decodeRequesterEmail recovers the exact original — including
 * subdomains and "="-bearing locals.
 */
export function toInboundHashedEmail(originalEmail: string, inboundDomain: string): string {
  const hashedLocal = originalEmail.trim().replace("@", "=");
  return `${hashedLocal}@${inboundDomain}`;
}

/**
 * Reverse the inbound-hashed requester email back to the real address.
 *
 * Current scheme: "@" encoded as "=" (boundary is the last "="). A legacy "."-encoded form is
 * still decoded best-effort for older tickets. Addresses not under the hash domain are already
 * real (e.g. a ticket opened directly in Helpdesk) and returned unchanged.
 */
export function decodeRequesterEmail(
  requesterEmail: string | undefined | null,
  inboundDomain: string
): string {
  const raw = (requesterEmail ?? "").trim();
  if (!raw) return "";

  const domain = inboundDomain.toLowerCase().trim();
  const suffix = `@${domain}`;
  // Not under the hash domain -> already a real address.
  if (!domain || !raw.toLowerCase().endsWith(suffix)) return raw;

  const localHash = raw.slice(0, raw.length - suffix.length);

  // Current scheme: "@" was encoded as "=". The boundary is the last "=" (domains never
  // contain "="), so this is exact even for subdomains and "="-bearing locals.
  const eq = localHash.lastIndexOf("=");
  if (eq > 0 && eq < localHash.length - 1) {
    const realLocal = localHash.slice(0, eq);
    const realDomain = localHash.slice(eq + 1);
    if (realLocal && realDomain.includes(".")) {
      return `${realLocal}@${realDomain}`;
    }
  }

  // Legacy "."-encoded form (pre-reversible scheme): best-effort two-label reverse.
  const parts = localHash.split(".");
  if (parts.length < 3) return raw;
  const legacyDomain = parts.slice(-2).join(".");
  const legacyLocal = parts.slice(0, -2).join(".");
  if (!legacyLocal || !legacyDomain) return raw;

  return `${legacyLocal}@${legacyDomain}`;
}
