// Tests for inbox->team routing and the inbound loop guard (routing.ts). Pure helpers; the
// loop guard reads the hash domain via requester-hash, so no @azure/functions mock is needed.

import {
  normalizeInbox,
  routeTeam,
  shouldIgnoreSender,
  shouldSuppressRecipient,
} from "./routing";

const TEAM_ESCAPE = "3db812da-2055-436f-9889-7073b5e976f4";
const TEAM_UREFERRALS = "61ed7601-b6e3-43c2-936a-7afe45e4e246";
const TEAM_ESCAPE_REFERRALS = "3a5e9d73-e5a0-442e-888b-6573672c9d05";

// hashDomain() now REQUIRES RELAY_HASH_DOMAIN (no hardcoded default), and the loop guard reads it,
// so give every test a value; specific tests below override or delete it to exercise edge behavior.
beforeEach(() => {
  process.env.RELAY_HASH_DOMAIN = "core-parser-01.corespecialty.com";
});

describe("normalizeInbox", () => {
  it("rewrites the domain to corespecialty.com, keeping the local part", () => {
    expect(normalizeInbox("escape@whatever.example")).toBe("escape@corespecialty.com");
  });
  it("defaults to unknown@ when the address is missing", () => {
    expect(normalizeInbox(null)).toBe("unknown@corespecialty.com");
    expect(normalizeInbox(undefined)).toBe("unknown@corespecialty.com");
  });
  it("handles a value without an @", () => {
    expect(normalizeInbox("escape")).toBe("escape@corespecialty.com");
  });
});

describe("routeTeam", () => {
  it("maps known inboxes to their team IDs", () => {
    expect(routeTeam("escape@corespecialty.com")).toBe(TEAM_ESCAPE);
    expect(routeTeam("ureferrals@corespecialty.com")).toBe(TEAM_UREFERRALS);
    expect(routeTeam("escapereferrals@corespecialty.com")).toBe(TEAM_ESCAPE_REFERRALS);
  });
  it("falls back to the Escape team for unknown inboxes", () => {
    expect(routeTeam("unknown@corespecialty.com")).toBe(TEAM_ESCAPE);
  });
});

describe("shouldIgnoreSender", () => {
  const ORIGINAL = process.env.RELAY_HASH_DOMAIN;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.RELAY_HASH_DOMAIN;
    else process.env.RELAY_HASH_DOMAIN = ORIGINAL;
  });

  it("ignores helpdesk.com and the onmicrosoft tenant senders", () => {
    expect(shouldIgnoreSender("noreply@helpdesk.com")).toBe(true);
    expect(shouldIgnoreSender("svc@corespecialty.onmicrosoft.com")).toBe(true);
  });
  it("ignores the configured hash domain (loop guard)", () => {
    process.env.RELAY_HASH_DOMAIN = "core-parser-01.corespecialty.com";
    expect(shouldIgnoreSender("bounce@core-parser-01.corespecialty.com")).toBe(true);
  });
  it("throws when no hash domain is configured (required env, no hardcoded default)", () => {
    delete process.env.RELAY_HASH_DOMAIN;
    expect(() => shouldIgnoreSender("x@core-parser-01.corespecialty.com")).toThrow(/RELAY_HASH_DOMAIN/);
  });
  it("does not ignore a normal external sender", () => {
    expect(shouldIgnoreSender("customer@gmail.com")).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(shouldIgnoreSender("NoReply@HelpDesk.Com")).toBe(true);
  });
  it("ignores subdomains of an ignored domain (dot-suffix match)", () => {
    expect(shouldIgnoreSender("bounce@mail.helpdesk.com")).toBe(true);
  });
  it("does NOT ignore a lookalike domain or a pattern in the local part (boundary, not substring)", () => {
    expect(shouldIgnoreSender("x@foohelpdesk.com")).toBe(false); // not a real subdomain
    expect(shouldIgnoreSender("x@helpdesk.com.evil.test")).toBe(false); // pattern is not the domain suffix
    expect(shouldIgnoreSender("helpdesk.com@gmail.com")).toBe(false); // pattern only in local part
  });
});

describe("shouldSuppressRecipient (outbound loop guard)", () => {
  const ORIG_MB = process.env.MAILBOX_ADDRESSES;
  const ORIG_DOMAINS = process.env.RELAY_IN_SCOPE_DOMAINS;
  const ORIG_HASH = process.env.RELAY_HASH_DOMAIN;
  beforeEach(() => {
    // The drain mailboxes as actually configured — enumerated on the alias domain only.
    process.env.MAILBOX_ADDRESSES =
      "escape@corespecialtyins.com,escapereferrals@corespecialtyins.com";
  });
  afterEach(() => {
    const restore = (k: string, v: string | undefined) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    restore("MAILBOX_ADDRESSES", ORIG_MB);
    restore("RELAY_IN_SCOPE_DOMAINS", ORIG_DOMAINS);
    restore("RELAY_HASH_DOMAIN", ORIG_HASH);
  });

  it("suppresses a drain mailbox by exact MAILBOX_ADDRESSES match", () => {
    expect(shouldSuppressRecipient("escape@corespecialtyins.com")).toBe(true);
    expect(shouldSuppressRecipient("escapereferrals@corespecialtyins.com")).toBe(true);
  });

  it("suppresses a drain mailbox under its alias (UPN) company domain — never loops", () => {
    // Not literally in MAILBOX_ADDRESSES, but the same mailbox on the UPN domain.
    expect(shouldSuppressRecipient("escape@corespecialty.com")).toBe(true);
    expect(shouldSuppressRecipient("ESCAPE@CoreSpecialty.com")).toBe(true); // case-insensitive
    expect(shouldSuppressRecipient("escapereferrals@corespecialty.com")).toBe(true);
  });

  it("suppresses a drain mailbox under a +tag subaddress (routes to the base mailbox)", () => {
    expect(shouldSuppressRecipient("escape+anything@corespecialty.com")).toBe(true);
    expect(shouldSuppressRecipient("escape+tag@corespecialtyins.com")).toBe(true);
  });

  it("does NOT suppress ordinary internal senders (they must get replies)", () => {
    expect(shouldSuppressRecipient("john.doe@corespecialty.com")).toBe(false);
    expect(shouldSuppressRecipient("jane@corespecialtyins.com")).toBe(false);
    expect(shouldSuppressRecipient("agent@corespecialty.com")).toBe(false);
  });

  it("does NOT suppress an external address that merely shares a mailbox local part", () => {
    expect(shouldSuppressRecipient("escape@gmail.com")).toBe(false);
    expect(shouldSuppressRecipient("escape@randomco.example")).toBe(false);
  });

  it("suppresses an exact configured mailbox even on an out-of-scope domain", () => {
    process.env.MAILBOX_ADDRESSES = "relaybox@otherdomain.test";
    expect(shouldSuppressRecipient("relaybox@otherdomain.test")).toBe(true);
    // ...but a same-local-part address on a non-in-scope domain is left alone.
    expect(shouldSuppressRecipient("relaybox@elsewhere.test")).toBe(false);
  });

  it("suppresses system/loop addresses (reuses shouldIgnoreSender)", () => {
    expect(shouldSuppressRecipient("noreply@helpdesk.com")).toBe(true);
    expect(shouldSuppressRecipient("svc@corespecialty.onmicrosoft.com")).toBe(true);
  });

  it("does NOT suppress an external requester", () => {
    expect(shouldSuppressRecipient("customer@gmail.com")).toBe(false);
    expect(shouldSuppressRecipient("broker@example.com")).toBe(false);
    // A lookalike domain must not be matched as in-scope.
    expect(shouldSuppressRecipient("evil@notcorespecialty.com.evil.test")).toBe(false);
  });

  it("honors a RELAY_IN_SCOPE_DOMAINS override for alias detection", () => {
    process.env.MAILBOX_ADDRESSES = "escape@corespecialty.com";
    process.env.RELAY_IN_SCOPE_DOMAINS = "acme.example";
    // Same mailbox local part on the override domain is caught as an alias...
    expect(shouldSuppressRecipient("escape@acme.example")).toBe(true);
    // ...and the default company domains are no longer treated as in-scope for alias detection.
    expect(shouldSuppressRecipient("escape@corespecialtyins.com")).toBe(false);
  });

  it("is false for empty/missing input", () => {
    expect(shouldSuppressRecipient("")).toBe(false);
    expect(shouldSuppressRecipient(null)).toBe(false);
    expect(shouldSuppressRecipient(undefined)).toBe(false);
  });
});
