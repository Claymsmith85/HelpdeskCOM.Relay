// Tests for the email-subject threading helpers in subject.ts.
// These lock in the "[#shortID]" tagging behavior added this session:
//  - extractTicketRef: last tag wins, whitespace tolerant, null-safe
//  - withTicketRef: strip-then-append (no accumulation across reply round-trips)
//  - normalizeRef: trim + lowercase for case-insensitive comparison

import { extractTicketRef, withTicketRef, normalizeRef } from "./subject";

describe("extractTicketRef", () => {
  it("extracts the shortID from a tagged subject", () => {
    expect(extractTicketRef("Need help [#ABC123]")).toBe("ABC123");
  });

  it("returns the LAST reference when several are present (forwarded chains)", () => {
    expect(extractTicketRef("Re: Fwd: [#OLD] thread [#NEW]")).toBe("NEW");
  });

  it("tolerates whitespace inside the brackets", () => {
    expect(extractTicketRef("Subject [#  ABC-1 ]")).toBe("ABC-1");
  });

  it("accepts the allowed id character set (alnum . _ -)", () => {
    expect(extractTicketRef("x [#a.b_c-1]")).toBe("a.b_c-1");
  });

  it("returns null when there is no tag", () => {
    expect(extractTicketRef("just a plain subject")).toBeNull();
  });

  it.each([null, undefined, ""])("returns null for %p", (input) => {
    expect(extractTicketRef(input as any)).toBeNull();
  });
});

describe("withTicketRef", () => {
  it("appends a clean reference tag", () => {
    expect(withTicketRef("Ticket created: Hello", "ABC")).toBe(
      "Ticket created: Hello [#ABC]"
    );
  });

  it("strips an existing tag before appending (no accumulation)", () => {
    expect(withTicketRef("Re: Hello [#OLD]", "NEW")).toBe("Re: Hello [#NEW]");
  });

  it("strips multiple existing tags and collapses whitespace", () => {
    expect(withTicketRef("Re: [#A] Hello [#B]  world", "C")).toBe(
      "Re: Hello world [#C]"
    );
  });

  it("returns the bare (de-tagged) subject when no shortID is supplied", () => {
    expect(withTicketRef("Hello [#OLD] world", null)).toBe("Hello world");
    expect(withTicketRef("Hello", "")).toBe("Hello");
  });

  it("handles a null/empty subject (leading space is the current behavior)", () => {
    expect(withTicketRef(null, "ABC")).toBe(" [#ABC]");
    expect(withTicketRef("", "ABC")).toBe(" [#ABC]");
  });

  it("collapses a run of Re/RE prefixes to a single Re:", () => {
    expect(withTicketRef("Re: RE: RE: Testing reply cleanup [#JH11XV]", "JH11XV")).toBe(
      "Re: Testing reply cleanup [#JH11XV]"
    );
  });

  it("collapses Fwd:/FW: prefixes into a single Re:", () => {
    expect(withTicketRef("Fwd: FW: Re: Hello", "A")).toBe("Re: Hello [#A]");
  });

  it("leaves a single Re: prefix as one Re:", () => {
    expect(withTicketRef("Re: Hello", "A")).toBe("Re: Hello [#A]");
  });

  it("does not strip a non-prefix word that ends in a colon", () => {
    expect(withTicketRef("Review: budget", "A")).toBe("Review: budget [#A]");
    expect(withTicketRef("Ticket has been created: Need help", "A")).toBe(
      "Ticket has been created: Need help [#A]"
    );
  });
});

describe("normalizeRef", () => {
  it("trims and lowercases", () => {
    expect(normalizeRef("  AbC123 ")).toBe("abc123");
  });

  it.each([null, undefined, ""])("returns empty string for %p", (input) => {
    expect(normalizeRef(input as any)).toBe("");
  });

  it("makes equal-but-differently-cased refs comparable", () => {
    expect(normalizeRef("ABC")).toBe(normalizeRef("abc"));
  });
});
