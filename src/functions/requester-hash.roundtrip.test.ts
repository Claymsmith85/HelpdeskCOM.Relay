// Tests for the reversible, subdomain-safe requester-hash encoding (requester-hash.ts).
//   toInboundHashedEmail : "<local>@<domain>" -> "<local>=<domain>@<inbound>"
//   decodeRequesterEmail : reverses it (last "=" is the boundary)
// Both live in one module now, so no @azure/functions side effects to mock.

import { toInboundHashedEmail, decodeRequesterEmail } from "./requester-hash";

const INBOUND = "core-parser-01.corespecialty.com";

describe("toInboundHashedEmail", () => {
  it('encodes the "@" as "=" for a plain address', () => {
    expect(toInboundHashedEmail("john@example.com", INBOUND)).toBe(`john=example.com@${INBOUND}`);
  });
  it("is subdomain-safe", () => {
    expect(toInboundHashedEmail("john@sub.example.com", INBOUND)).toBe(`john=sub.example.com@${INBOUND}`);
  });
  it("trims surrounding whitespace before encoding", () => {
    expect(toInboundHashedEmail("  john@example.com  ", INBOUND)).toBe(`john=example.com@${INBOUND}`);
  });
});

describe("encode -> decode is identity", () => {
  it.each([
    "john@example.com",
    "john@sub.example.com", // subdomain
    "first.last@deep.sub.example.co.uk", // multi-label subdomain + dotted local
    "od=d@example.com", // "="-bearing local part
  ])("round-trips %s", (original) => {
    const hashed = toInboundHashedEmail(original, INBOUND);
    expect(hashed.endsWith(`@${INBOUND}`)).toBe(true);
    expect(decodeRequesterEmail(hashed, INBOUND)).toBe(original);
  });
});

describe("decodeRequesterEmail", () => {
  it("decodes the legacy dot-encoded form best-effort (two-label domain)", () => {
    expect(decodeRequesterEmail(`john.example.com@${INBOUND}`, INBOUND)).toBe("john@example.com");
  });

  it("passes through addresses not under the inbound parse domain", () => {
    expect(decodeRequesterEmail("real@elsewhere.com", INBOUND)).toBe("real@elsewhere.com");
  });

  it("returns empty string for empty/null input", () => {
    expect(decodeRequesterEmail("", INBOUND)).toBe("");
    expect(decodeRequesterEmail(null, INBOUND)).toBe("");
    expect(decodeRequesterEmail(undefined, INBOUND)).toBe("");
  });

  it("passes through unchanged when no inbound domain is configured", () => {
    expect(decodeRequesterEmail(`john=example.com@${INBOUND}`, "")).toBe(`john=example.com@${INBOUND}`);
  });

  it("is case-insensitive about the inbound domain suffix", () => {
    expect(decodeRequesterEmail(`john=example.com@${INBOUND.toUpperCase()}`, INBOUND)).toBe("john@example.com");
  });
});
