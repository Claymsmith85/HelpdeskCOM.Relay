// Tests for the follower / people-in-the-loop notice module (ticket-notices.ts): event
// classification, the defensive recipient extractor, per-audience visibility, echo control, and
// the never-throw send orchestration. Graph and Helpdesk boundaries are mocked at the module
// boundary (the helpdesk.handler.test.ts convention).

jest.mock("./graph-mail", () => ({ sendMailViaGraph: jest.fn().mockResolvedValue(undefined) }));
jest.mock("./helpdesk-client", () => ({ listAgents: jest.fn() }));

import { sendMailViaGraph } from "./graph-mail";
import { listAgents } from "./helpdesk-client";
import {
  classifyLastEvent,
  extractNoticeRecipients,
  sendTicketNotices,
} from "./ticket-notices";

const sendMock = sendMailViaGraph as jest.Mock;
const agentsMock = listAgents as jest.Mock;

const step = jest.fn();
const stepError = jest.fn();

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.MAILBOX_ADDRESSES;
});

// #region classifyLastEvent

describe("classifyLastEvent", () => {
  it("classifies a message event with privacy and system-note flags", () => {
    const ev = classifyLastEvent([
      {
        author: { type: "agent", ID: "ag1", name: "Sam" },
        message: { text: "System note: skipped files", isPrivate: true },
      },
    ] as any);
    expect(ev).toMatchObject({
      kind: "message",
      authorId: "ag1",
      isPrivate: true,
      isSystemNote: true,
      authorType: "agent",
      authorName: "Sam",
    });
  });

  it("classifies a status change and drops a no-op one", () => {
    expect(classifyLastEvent([{ status: { old: "open", new: "solved" } }] as any)).toMatchObject({
      kind: "status",
      oldStatus: "open",
      newStatus: "solved",
    });
    expect(classifyLastEvent([{ status: { old: "open", new: "open" } }] as any)).toBeNull();
  });

  it("classifies an assignment change with best-effort names", () => {
    const ev = classifyLastEvent([
      { assignment: { new: { team: { ID: "t", name: "Escape" }, agent: { ID: "a", name: "Sam" } }, old: {} } },
    ] as any);
    expect(ev).toMatchObject({ kind: "assignment", newTeam: "Escape", newAgent: "Sam" });
  });

  it("returns null for empty/missing events and unrecognized shapes", () => {
    expect(classifyLastEvent(undefined)).toBeNull();
    expect(classifyLastEvent([] as any)).toBeNull();
    expect(classifyLastEvent([{ attachments: { files: [] } }] as any)).toBeNull(); // attachments-only
    expect(classifyLastEvent([{ message: { text: "   " } }] as any)).toBeNull(); // empty text
  });

  it("classifies the LAST event, not an earlier one", () => {
    const ev = classifyLastEvent([
      { message: { text: "first" }, author: { type: "client" } },
      { status: { old: "open", new: "pending" } },
    ] as any);
    expect(ev).toMatchObject({ kind: "status" });
  });
});

// #endregion

// #region extractNoticeRecipients

describe("extractNoticeRecipients", () => {
  const getAgents = jest.fn();

  afterEach(() => getAgents.mockReset());

  it("handles email strings, {email} objects, and follower agent IDs (bare or {ID})", async () => {
    getAgents.mockResolvedValue([
      { ID: "ag1", email: "Fol1@CoreSpecialty.com" },
      { ID: "ag2", email: "fol2@corespecialty.com" },
    ]);

    const out = await extractNoticeRecipients({
      followers: [{ ID: "ag1" }, "ag2", "direct@corespecialty.com"],
      cc: ["ext@example.com", { email: "Ext2@Example.com" }],
      getAgents,
      log: step,
    });

    expect(out).toEqual(
      expect.arrayContaining([
        { email: "fol1@corespecialty.com", source: "follower", agentId: "ag1" },
        { email: "fol2@corespecialty.com", source: "follower", agentId: "ag2" },
        { email: "direct@corespecialty.com", source: "follower", agentId: undefined },
        { email: "ext@example.com", source: "cc", agentId: undefined },
        { email: "ext2@example.com", source: "cc", agentId: undefined },
      ])
    );
    expect(getAgents).toHaveBeenCalledTimes(1); // lazily memoized: one lookup for two ID entries
  });

  it("does not call getAgents when every entry already carries an email", async () => {
    const out = await extractNoticeRecipients({
      followers: ["a@b.co"],
      cc: [{ email: "c@d.co" }],
      getAgents,
    });
    expect(out).toHaveLength(2);
    expect(getAgents).not.toHaveBeenCalled();
  });

  it("dedupes by email with follower winning over cc", async () => {
    const out = await extractNoticeRecipients({
      followers: ["Both@Example.com"],
      cc: ["both@example.com"],
      getAgents,
    });
    expect(out).toEqual([{ email: "both@example.com", source: "follower", agentId: undefined }]);
  });

  it("skips junk entries and cc IDs (no contact lookup exists), logging them", async () => {
    const out = await extractNoticeRecipients({
      followers: [42, null],
      cc: [{ ID: "contact-1" }, "not-an-email"],
      getAgents,
      log: step,
    });
    expect(out).toEqual([]);
    expect(getAgents).not.toHaveBeenCalled();
    expect(step.mock.calls.some(([msg]) => String(msg).includes("unrecognized"))).toBe(true);
  });

  it("degrades to email-bearing entries when the agent lookup fails", async () => {
    getAgents.mockRejectedValue(new Error("agents down"));
    const out = await extractNoticeRecipients({
      followers: [{ ID: "ag1" }, "direct@corespecialty.com"],
      cc: [],
      getAgents,
      log: step,
    });
    expect(out).toEqual([{ email: "direct@corespecialty.com", source: "follower", agentId: undefined }]);
  });

  it("tolerates non-array followers/cc", async () => {
    const out = await extractNoticeRecipients({ followers: undefined, cc: "junk", getAgents });
    expect(out).toEqual([]);
  });
});

// #endregion

// #region sendTicketNotices

const FOLLOWER = "follower@corespecialty.com";
const LOOP = "loop@example.com";

function payload(over: Record<string, any> = {}): any {
  return {
    eventType: "tickets.update",
    payload: {
      ID: "T1",
      shortID: "AB12",
      subject: "Printer down",
      requester: { email: "jane@example.com", name: "Jane" },
      customFields: { email: "jane@example.com", inbox: "escape@corespecialty.com" },
      followers: [{ ID: "ag1" }],
      cc: [LOOP],
      events: [
        {
          author: { type: "agent", ID: "ag9", name: "Sam Agent" },
          source: { type: "api" },
          message: { text: "On it.", isPrivate: false },
        },
      ],
      ...over,
    },
  };
}

function callNotices(p: any) {
  return sendTicketNotices({
    graph: {} as any,
    helpdesk: {} as any,
    payload: p,
    mailbox: "escape@corespecialty.com",
    step,
    stepError,
  });
}

describe("sendTicketNotices", () => {
  beforeEach(() => {
    agentsMock.mockResolvedValue([{ ID: "ag1", email: FOLLOWER }]);
  });

  it("emails followers and loop people a public agent reply, threaded from the ticket mailbox", async () => {
    await callNotices(payload());

    expect(sendMock).toHaveBeenCalledTimes(2);
    const tos = sendMock.mock.calls.map((c) => c[0].to).sort();
    expect(tos).toEqual([FOLLOWER, LOOP]);
    const arg = sendMock.mock.calls[0][0];
    expect(arg.mailbox).toBe("escape@corespecialty.com");
    expect(arg.subject).toBe("Re: Printer down [#AB12]");
    expect(arg.body).toBe("Sam Agent added a reply to ticket AB12:\n\nOn it.");
  });

  it("sends private notes and assignment changes to followers ONLY", async () => {
    await callNotices(
      payload({
        events: [
          { author: { type: "agent", ID: "ag9", name: "Sam" }, message: { text: "internal", isPrivate: true } },
        ],
      })
    );
    expect(sendMock.mock.calls.map((c) => c[0].to)).toEqual([FOLLOWER]);

    sendMock.mockClear();
    await callNotices(
      payload({
        events: [
          { author: { type: "agent", ID: "ag9" }, assignment: { new: { team: { ID: "t", name: "Escape" } }, old: {} } },
        ],
      })
    );
    expect(sendMock.mock.calls.map((c) => c[0].to)).toEqual([FOLLOWER]);
  });

  it("sends status changes to both audiences", async () => {
    await callNotices(payload({ events: [{ author: { type: "agent", ID: "ag9" }, status: { old: "open", new: "solved" } }] }));
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][0].body).toBe("Ticket AB12 status changed: open -> solved.");
  });

  it("never notifies the event's author about their own event", async () => {
    // The follower ag1 authored the reply -> only the loop person hears about it.
    await callNotices(
      payload({ events: [{ author: { type: "agent", ID: "ag1", name: "Fol" }, message: { text: "mine", isPrivate: false } }] })
    );
    expect(sendMock.mock.calls.map((c) => c[0].to)).toEqual([LOOP]);
  });

  it("never notifies the requester through the cc list", async () => {
    await callNotices(payload({ cc: [LOOP, "jane@example.com"] }));
    expect(sendMock.mock.calls.map((c) => c[0].to).sort()).toEqual([FOLLOWER, LOOP]);
  });

  it("excludes the relayed-from sender of a threaded non-requester reply and attributes them", async () => {
    await callNotices(
      payload({
        cc: [LOOP],
        events: [
          {
            author: { type: "client", ID: "c1", name: "Jane" },
            message: { text: `[Relayed from ${LOOP}]\n\nMy two cents`, isPrivate: false },
          },
        ],
      })
    );
    // The loop person who sent the reply is excluded; the follower's notice names them.
    expect(sendMock.mock.calls.map((c) => c[0].to)).toEqual([FOLLOWER]);
    expect(sendMock.mock.calls[0][0].body).toContain(`${LOOP} added a reply`);
  });

  it("suppresses drain-mailbox recipients (outbound loop guard)", async () => {
    process.env.MAILBOX_ADDRESSES = "escape@corespecialty.com";
    await callNotices(payload({ cc: [LOOP, "escape@corespecialty.com"] }));
    expect(sendMock.mock.calls.map((c) => c[0].to).sort()).toEqual([FOLLOWER, LOOP]);
  });

  it("isolates per-recipient failures and never throws", async () => {
    sendMock.mockRejectedValueOnce(new Error("graph down"));
    await expect(callNotices(payload())).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(2); // second recipient still attempted
    expect(stepError).toHaveBeenCalled();
  });

  it("fast-paths without any API call when the ticket has no followers/cc or no noticeable event", async () => {
    await callNotices(payload({ followers: [], cc: [] }));
    await callNotices(payload({ events: [] }));
    expect(agentsMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("resolves even when the whole pass blows up (best-effort by contract)", async () => {
    agentsMock.mockRejectedValue(new Error("helpdesk down"));
    await expect(callNotices(payload())).resolves.toBeUndefined();
  });
});

// #endregion
