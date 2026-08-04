// Unit tests for the customer-facing copy (templates.ts): the auto-reply / agent-reply emails, the
// uploaded-attachment body block, and the oversize "System note". Pure string-building, no mocks.

import {
  existingTicketAutoReply,
  agentReplyEmail,
  appendFolderAndFilenamesToBody,
  buildOversizeCommentText,
  relayedFromMarker,
  parseRelayedFrom,
  noticeMessageEmail,
  noticeStatusEmail,
  noticeAssignmentEmail,
} from "./templates";
import type { AttachmentMeta } from "./graph-mail";

describe("existingTicketAutoReply", () => {
  it("threads a Re: subject and acknowledges the update", () => {
    const { subject, body } = existingTicketAutoReply({
      inboundSubject: "Need help",
      shortId: "OLD1",
      ticketId: "T-INTERNAL",
    });
    expect(subject).toBe("Re: Need help [#OLD1]");
    expect(body).toBe("We've received your reply and updated ticket OLD1.");
  });

  it("collapses stacked Re/RE prefixes from the inbound subject to a single Re:", () => {
    const { subject } = existingTicketAutoReply({
      inboundSubject: "RE: RE: Testing reply cleanup [#JH11XV]",
      shortId: "JH11XV",
      ticketId: "T-INTERNAL",
    });
    expect(subject).toBe("Re: Testing reply cleanup [#JH11XV]");
  });
});

describe("agentReplyEmail", () => {
  it("threads a Re: subject and passes the agent body through unchanged", () => {
    const { subject, body } = agentReplyEmail({
      inboundSubject: "Open topic",
      shortId: "XYZ",
      body: "Here is the answer",
    });
    expect(subject).toBe("Re: Open topic [#XYZ]");
    expect(body).toBe("Here is the answer");
  });
});

describe("appendFolderAndFilenamesToBody", () => {
  it("returns the base text unchanged when there are no files and no folder", () => {
    expect(appendFolderAndFilenamesToBody("Hello", [])).toBe("Hello");
  });
  it("renders the folder link and a bulleted list of filenames", () => {
    expect(appendFolderAndFilenamesToBody("Body text", ["doc1.pdf", "doc2.pdf"], "https://sp/folder")).toBe(
      ["Body text", "", "Ticket folder:", "https://sp/folder", "", "Attachments received:", "- doc1.pdf", "- doc2.pdf"].join("\n")
    );
  });
  it('shows "(none)" when a folder exists but no files were uploaded', () => {
    const out = appendFolderAndFilenamesToBody("Body", [], "https://sp/folder");
    expect(out).toContain("Ticket folder:");
    expect(out).toContain("(none)");
  });
});

describe("buildOversizeCommentText", () => {
  const maxBytesPerFile = 100 * 1024 * 1024;

  it("names each blocked file with its size and the per-file limit", () => {
    const blocked: AttachmentMeta[] = [
      { filename: "huge.zip", size: 120 * 1024 * 1024 },
      { filename: "big.mov", size: 110 * 1024 * 1024 },
    ];
    const text = buildOversizeCommentText({ blocked, maxBytesPerFile });
    expect(text).toContain("System note:");
    expect(text).toContain("exceeded the 100.00 MiB per-file limit");
    expect(text).toContain("- huge.zip (120.00 MiB)");
    expect(text).toContain("- big.mov (110.00 MiB)");
    expect(text).toContain("remain in the mailbox");
  });
});

describe("relayedFromMarker / parseRelayedFrom", () => {
  it("round-trips: the parser reads exactly what the builder wrote", () => {
    const marker = relayedFromMarker("Follower@CoreSpecialty.com");
    expect(marker).toBe("[Relayed from Follower@CoreSpecialty.com]");
    expect(parseRelayedFrom(`${marker}\n\nActual reply text`)).toBe("follower@corespecialty.com");
  });

  it("matches the FIRST line only — a quoted marker deeper in the text does not count", () => {
    expect(parseRelayedFrom("Reply text\n[Relayed from a@b.co]\nmore")).toBeNull();
  });

  it("returns null for ordinary text, empty, and null/undefined", () => {
    expect(parseRelayedFrom("Hello there")).toBeNull();
    expect(parseRelayedFrom("")).toBeNull();
    expect(parseRelayedFrom(null)).toBeNull();
    expect(parseRelayedFrom(undefined)).toBeNull();
  });
});

describe("notice templates", () => {
  const base = { ticketSubject: "Printer down", shortId: "AB12", ref: "AB12" };

  it("noticeMessageEmail threads the subject and labels reply / private note / system note", () => {
    const reply = noticeMessageEmail({ ...base, authorLabel: "Sam Agent", text: "On it.", isPrivate: false, isSystemNote: false });
    expect(reply.subject).toBe("Re: Printer down [#AB12]");
    expect(reply.body).toBe("Sam Agent added a reply to ticket AB12:\n\nOn it.");

    const priv = noticeMessageEmail({ ...base, authorLabel: "Sam Agent", text: "internal", isPrivate: true, isSystemNote: false });
    expect(priv.body).toContain("added a private note");

    const sys = noticeMessageEmail({ ...base, authorLabel: "Relay", text: "System note: x", isPrivate: false, isSystemNote: true });
    expect(sys.body).toContain("added a system note");
  });

  it("noticeStatusEmail threads the subject and shows old -> new", () => {
    const { subject, body } = noticeStatusEmail({ ...base, oldStatus: "open", newStatus: "solved" });
    expect(subject).toBe("Re: Printer down [#AB12]");
    expect(body).toBe("Ticket AB12 status changed: open -> solved.");
  });

  it("noticeAssignmentEmail falls back to 'unassigned' for missing parts", () => {
    const { subject, body } = noticeAssignmentEmail({ ...base, newTeam: "Escape" });
    expect(subject).toBe("Re: Printer down [#AB12]");
    expect(body).toBe("Ticket AB12 was reassigned — team: Escape, agent: unassigned.");
  });
});
