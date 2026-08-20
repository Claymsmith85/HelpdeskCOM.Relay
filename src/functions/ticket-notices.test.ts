// Tests for the ticket notice module (ticket-notices.ts): event classification, the defensive
// recipient extractor, follower/cc and assigned-agent visibility, echo control, cross-audience
// dedupe, and the never-throw send orchestration. Graph and Helpdesk boundaries are mocked at the
// module boundary (the helpdesk.handler.test.ts convention).

jest.mock("./graph-mail", () => ({ sendMailViaGraph: jest.fn().mockResolvedValue(undefined) }));
jest.mock("./helpdesk-client", () => ({ listAgents: jest.fn() }));
// Keep the real noticeClaimBlobName (the send-once tests assert the claim key); the storage-backed
// operations are stubbed so no test builds a real blob client.
jest.mock("./reply-claims", () => ({
  ...jest.requireActual("./reply-claims"),
  buildReplyClaimsClient: jest.fn(),
  isReplyClaimed: jest.fn(),
  claimReply: jest.fn(),
}));

import { sendMailViaGraph } from "./graph-mail";
import { listAgents } from "./helpdesk-client";
import { buildReplyClaimsClient, claimReply, isReplyClaimed } from "./reply-claims";
import {
  classifyLastEvent,
  extractNoticeRecipients,
  sendTicketNotices,
} from "./ticket-notices";

const sendMock = sendMailViaGraph as jest.Mock;
const agentsMock = listAgents as jest.Mock;
const claimClientMock = buildReplyClaimsClient as jest.Mock;
const isClaimedMock = isReplyClaimed as jest.Mock;
const claimReplyMock = claimReply as jest.Mock;

const step = jest.fn();
const stepError = jest.fn();

beforeEach(() => {
  // Send-once claim happy path: storage reachable, nothing claimed yet.
  claimClientMock.mockResolvedValue({ id: "storage" });
  isClaimedMock.mockResolvedValue(false);
  claimReplyMock.mockResolvedValue(true);
});

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

  it("classifies a cc (people-in-the-loop) change by email diff — the live payload shape", () => {
    // Verbatim shape from a real ticket read (2026-08-04): event type "cc", {new, old} lists.
    const ev = classifyLastEvent([
      {
        type: "cc",
        author: { type: "agent", ID: "ag1", name: "Clayton Smith" },
        cc: { new: [{ email: "Tommy.Kanger@corespecialty.com" }], old: [] },
      },
    ] as any);
    expect(ev).toMatchObject({
      kind: "cc",
      added: ["tommy.kanger@corespecialty.com"],
      removed: [],
    });
  });

  it("classifies a followers change by ID diff, rendering names — the live payload shape", () => {
    const ev = classifyLastEvent([
      {
        type: "followers",
        author: { type: "agent", ID: "ag1", name: "Clayton Smith" },
        followers: { new: [{ ID: "a3f9130d", name: "Kardiner Cadet" }], old: [] },
      },
    ] as any);
    expect(ev).toMatchObject({ kind: "followers", added: ["Kardiner Cadet"], removed: [] });
  });

  it("drops a no-op audience change (new set equals old set)", () => {
    expect(
      classifyLastEvent([{ cc: { new: [{ email: "a@b.co" }], old: [{ email: "A@B.co" }] } }] as any)
    ).toBeNull();
    expect(
      classifyLastEvent([{ followers: { new: [{ ID: "x" }], old: [{ ID: "x", name: "N" }] } }] as any)
    ).toBeNull();
  });

  it("surfaces the author email of a client-authored event (live payloads carry it)", () => {
    const ev = classifyLastEvent([
      { author: { type: "client", email: "Jane@Example.com" }, message: { text: "hi" } },
    ] as any);
    expect(ev).toMatchObject({ kind: "message", authorEmail: "jane@example.com" });
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

  it("classifies the preceding message when a same-action attachments event trails it", () => {
    const ev = classifyLastEvent([
      {
        ID: 41,
        date: "2026-08-17T15:00:00.000Z",
        author: { type: "agent", ID: "ag9", name: "Sam Agent" },
        message: { text: "Please see attached.", isPrivate: false },
      },
      {
        ID: 42,
        date: "2026-08-17T15:00:00.900Z",
        author: { type: "agent", ID: "ag9", name: "Sam Agent" },
        attachments: { files: [{ name: "endorse.pdf" }], isPrivate: false },
      },
    ] as any);

    expect(ev).toMatchObject({
      kind: "message",
      text: "Please see attached.",
      eventId: "41",
    });
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

  it("handles the CONFIRMED live shapes: bare-GUID follower strings + {email, name|null} cc objects", async () => {
    getAgents.mockResolvedValue([
      { ID: "a3f9130d-3140-4e92-9542-9929ef9b6156", email: "kardiner.cadet@corespecialty.com" },
    ]);

    const out = await extractNoticeRecipients({
      followers: ["a3f9130d-3140-4e92-9542-9929ef9b6156"],
      cc: [{ email: "tommy.kanger@corespecialty.com", name: null }],
      getAgents,
    });

    expect(out).toEqual(
      expect.arrayContaining([
        {
          email: "kardiner.cadet@corespecialty.com",
          source: "follower",
          agentId: "a3f9130d-3140-4e92-9542-9929ef9b6156",
        },
        { email: "tommy.kanger@corespecialty.com", source: "cc", agentId: undefined },
      ])
    );
    expect(out).toHaveLength(2);
  });
});

// #endregion

// #region sendTicketNotices

const FOLLOWER = "follower@corespecialty.com";
const LOOP = "loop@example.com";
const ASSIGNED = "assigned.agent@corespecialty.com";

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

function callNotices(
  p: any,
  audiences: { followers: boolean; agent: boolean } = { followers: true, agent: false },
  helpdesk: any = {}
) {
  return sendTicketNotices({
    graph: {} as any,
    helpdesk,
    payload: p,
    mailbox: "escape@corespecialty.com",
    ...audiences,
    step,
    stepError,
  });
}

describe("sendTicketNotices", () => {
  beforeEach(() => {
    agentsMock.mockResolvedValue([{ ID: "ag1", email: FOLLOWER }]);
  });

  describe("assigned-agent audience", () => {
    it("emails the assigned agent a public reply even when that agent authored it", async () => {
      agentsMock.mockResolvedValue([{ ID: "ag9", email: ASSIGNED }]);

      await callNotices(
        payload({
          assignment: { agent: { ID: "ag9", name: "Sam Agent" } },
          events: [
            {
              author: { type: "agent", ID: "ag9", name: "Sam Agent" },
              message: { text: "My own reply", isPrivate: false },
            },
          ],
        }),
        { followers: false, agent: true }
      );

      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock.mock.calls[0][0]).toMatchObject({
        mailbox: "escape@corespecialty.com",
        to: ASSIGNED,
        subject: "Re: Printer down [#AB12]",
        body: "Sam Agent added a reply to ticket AB12:\n\nMy own reply",
      });
    });

    it("emails the assigned agent a public submitter reply", async () => {
      agentsMock.mockResolvedValue([{ ID: "ag9", email: ASSIGNED }]);

      await callNotices(
        payload({
          assignment: { agent: { ID: "ag9", name: "Sam Agent" } },
          events: [
            {
              author: { type: "client", email: "jane@example.com", name: "Jane" },
              message: { text: "Customer follow-up", isPrivate: false },
            },
          ],
        }),
        { followers: false, agent: true }
      );

      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock.mock.calls[0][0]).toMatchObject({
        to: ASSIGNED,
        body: "Jane added a reply to ticket AB12:\n\nCustomer follow-up",
      });
    });

    it("does not copy a relayed email reply back to that same assigned agent", async () => {
      agentsMock.mockResolvedValue([{ ID: "ag9", email: ASSIGNED }]);

      await callNotices(
        payload({
          assignment: { agent: { ID: "ag9", name: "Sam Agent" } },
          followers: [],
          cc: [ASSIGNED],
          events: [
            {
              author: { type: "client", ID: "c1" },
              message: {
                text: `[Relayed from ${ASSIGNED}]\n\nOut of office`,
                isPrivate: false,
              },
            },
          ],
        }),
        { followers: true, agent: true }
      );

      expect(sendMock).not.toHaveBeenCalled();
      expect(step).toHaveBeenCalledWith(
        expect.stringContaining("auto-responder loop guard"),
        { audience: "agent", to: ASSIGNED }
      );
    });

    it("does not email the assigned agent for private/system notes or ticket changes", async () => {
      const assigned = { agent: { ID: "ag9", name: "Sam Agent" } };

      await callNotices(
        payload({
          assignment: assigned,
          events: [
            {
              author: { type: "agent", ID: "ag9" },
              message: { text: "Private", isPrivate: true },
            },
          ],
        }),
        { followers: false, agent: true }
      );
      await callNotices(
        payload({
          assignment: assigned,
          events: [
            {
              author: { type: "agent", ID: "ag9" },
              message: { text: "System note: internal", isPrivate: false },
            },
          ],
        }),
        { followers: false, agent: true }
      );
      await callNotices(
        payload({
          assignment: assigned,
          events: [{ status: { old: "open", new: "solved" } }],
        }),
        { followers: false, agent: true }
      );
      await callNotices(
        payload({
          assignment: assigned,
          events: [
            {
              assignment: {
                new: { agent: { ID: "ag9", name: "Sam Agent" } },
                old: {},
              },
            },
          ],
        }),
        { followers: false, agent: true }
      );

      expect(sendMock).not.toHaveBeenCalled();
      expect(agentsMock).not.toHaveBeenCalled();
    });

    it("step-logs and skips an unresolvable assigned-agent ID", async () => {
      await callNotices(
        payload({ assignment: { agent: { ID: "missing", name: "Missing Agent" } } }),
        { followers: false, agent: true }
      );

      expect(agentsMock).toHaveBeenCalledTimes(1);
      expect(sendMock).not.toHaveBeenCalled();
      expect(
        step.mock.calls.some(([message]) =>
          String(message).includes("assigned agent ID not resolvable")
        )
      ).toBe(true);
    });

    it("sends one agent-rules copy when the assigned agent is also a follower", async () => {
      agentsMock.mockResolvedValue([{ ID: "ag1", email: FOLLOWER }]);

      await callNotices(
        payload({
          assignment: { agent: { ID: "ag1", name: "Follower Agent" } },
          cc: [],
        }),
        { followers: true, agent: true }
      );

      expect(agentsMock).toHaveBeenCalledTimes(1);
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock.mock.calls[0][0].to).toBe(FOLLOWER);
      expect(step).toHaveBeenCalledWith(
        "Notices: done",
        expect.objectContaining({
          recipients: 2,
          sent: 1,
          suppressed: 1,
          failed: 0,
          followers: { recipients: 1, sent: 0, suppressed: 1, failed: 0 },
          agent: { recipients: 1, sent: 1, suppressed: 0, failed: 0 },
        })
      );
    });

    it("sends only the agent copy when the follower/cc audience is disabled", async () => {
      agentsMock.mockResolvedValue([
        { ID: "ag1", email: FOLLOWER },
        { ID: "ag2", email: ASSIGNED },
      ]);

      await callNotices(
        payload({ assignment: { agent: { ID: "ag2", name: "Assigned Agent" } } }),
        { followers: false, agent: true }
      );

      expect(sendMock.mock.calls.map((c) => c[0].to)).toEqual([ASSIGNED]);
      expect(agentsMock).toHaveBeenCalledTimes(1);
      expect(
        step.mock.calls.some(([message]) => String(message).includes("raw follower/cc arrays"))
      ).toBe(false);
    });

    it("applies the outbound mailbox loop guard to the assigned agent", async () => {
      process.env.MAILBOX_ADDRESSES = ASSIGNED;
      agentsMock.mockResolvedValue([{ ID: "ag2", email: ASSIGNED }]);

      await callNotices(
        payload({ assignment: { agent: { ID: "ag2", name: "Assigned Agent" } } }),
        { followers: false, agent: true }
      );

      expect(sendMock).not.toHaveBeenCalled();
      expect(step).toHaveBeenCalledWith(
        "Notices: recipient suppressed (invalid or loop guard)",
        { audience: "agent", to: ASSIGNED }
      );
    });
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

  it("attaches files directly and strips the boilerplate attachment block when all files were attached", async () => {
    const helpdesk = {
      get: jest.fn().mockResolvedValue({ data: Buffer.from("pdf-binary") }),
    };

    await callNotices(
      payload({
        events: [
          {
            ID: 41,
            date: "2026-08-17T15:00:00.000Z",
            author: { type: "agent", ID: "ag9", name: "Sam Agent" },
            source: { type: "helpdesk" },
            message: {
              text: "Please see attached.\n---\nAttachments:\n- endorse-policy.pdf",
              isPrivate: false,
            },
          },
          {
            ID: 42,
            date: "2026-08-17T15:00:00.900Z",
            author: { type: "agent", ID: "ag9", name: "Sam Agent" },
            source: { type: "helpdesk" },
            attachments: {
              files: [{ ID: "f1", name: "endorse-policy.pdf", url: "https://files/1" }],
              isPrivate: false,
            },
          },
        ],
      }),
      { followers: true, agent: false },
      helpdesk
    );

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][0].body).toBe(
      "Sam Agent added a reply to ticket AB12:\n\nPlease see attached."
    );
    expect(sendMock.mock.calls[0][0].attachments).toEqual([
      expect.objectContaining({
        name: "endorse-policy.pdf",
        contentType: "application/octet-stream",
      }),
    ]);
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

  it("sends a loop-list change to both audiences — the newly added person gets their welcome", async () => {
    // LOOP was just added: the cc event fires with them already on the ticket's cc list.
    await callNotices(
      payload({
        events: [
          { author: { type: "agent", ID: "ag9" }, cc: { new: [{ email: LOOP }], old: [] } },
        ],
      })
    );
    expect(sendMock.mock.calls.map((c) => c[0].to).sort()).toEqual([FOLLOWER, LOOP]);
    expect(sendMock.mock.calls[0][0].body).toBe(
      `The people in the loop on ticket AB12 changed — added: ${LOOP}.`
    );
  });

  it("sends a follower-list change to followers ONLY (names internal agents)", async () => {
    await callNotices(
      payload({
        events: [
          {
            author: { type: "agent", ID: "ag9" },
            followers: { new: [{ ID: "ag1", name: "Fol Lower" }], old: [] },
          },
        ],
      })
    );
    expect(sendMock.mock.calls.map((c) => c[0].to)).toEqual([FOLLOWER]);
    expect(sendMock.mock.calls[0][0].body).toBe(
      "The followers on ticket AB12 changed — added: Fol Lower."
    );
  });

  it("never notifies a client author about their own event (author.email exclusion)", async () => {
    // The loop person emailed in; Helpdesk attributes the client event to their email.
    await callNotices(
      payload({
        events: [
          { author: { type: "client", email: LOOP }, message: { text: "from the loop", isPrivate: false } },
        ],
      })
    );
    expect(sendMock.mock.calls.map((c) => c[0].to)).toEqual([FOLLOWER]);
  });

  it("never notifies an AGENT author whose own address sits in the cc list (resolved via listAgents)", async () => {
    // Agent Sam (ag9) is kept "in the loop" by email; agent events carry no author.email, so the
    // authorId must be mapped to sam's address through the agent list.
    const SAM = "sam@corespecialty.com";
    agentsMock.mockResolvedValue([
      { ID: "ag1", email: FOLLOWER },
      { ID: "ag9", email: SAM },
    ]);

    await callNotices(payload({ cc: [{ email: SAM, name: null }] }));

    expect(sendMock.mock.calls.map((c) => c[0].to)).toEqual([FOLLOWER]);
    expect(agentsMock).toHaveBeenCalledTimes(1); // memoized: extractor + author lookup share one call
  });

  it("treats a public reply that merely QUOTES a system note as a reply (first-line anchoring)", async () => {
    await callNotices(
      payload({
        events: [
          {
            author: { type: "agent", ID: "ag9", name: "Sam" },
            message: { text: "See below.\nSystem note: file too large", isPrivate: false },
          },
        ],
      })
    );
    // Public visibility: both audiences get it, labeled a reply (not a system note).
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][0].body).toContain("added a reply");
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

// #region Same-action companion events + notice send-once claim

// A reply that auto-assigns the ticket lands [..., message, assignment] in one action; the
// classifier must surface the reply (the content people care about), not its companion assignment
// marker — mirroring helpdesk.ts's requester-path fix — while a standalone reassignment still
// notices as an assignment. The per-(ticket, event) claim caps the message fan-out at one pass.
describe("same-action companion events and the notice send-once claim", () => {
  beforeEach(() => {
    agentsMock.mockResolvedValue([{ ID: "ag1", email: FOLLOWER }]);
  });

  const T0 = "2026-08-17T15:00:00.000Z";
  const at = (offsetMs: number) => new Date(Date.parse(T0) + offsetMs).toISOString();

  const agentMsg = (over: any = {}) => ({
    ID: 41,
    date: T0,
    author: { type: "agent", ID: "ag9", name: "Sam Agent" },
    source: { type: "api" },
    message: { text: "Reply while unassigned", isPrivate: false },
    ...over,
  });
  const autoAssign = (over: any = {}) => ({
    ID: 42,
    date: at(800),
    author: { type: "agent", ID: "ag9", name: "Sam Agent" },
    source: { type: "api" },
    assignment: {
      new: { team: { ID: "t1", name: "Escape" }, agent: { ID: "ag9", name: "Sam Agent" } },
      old: { team: { ID: "t1", name: "Escape" } },
    },
    ...over,
  });
  const attachCompanion = (over: any = {}) => ({
    ID: 43,
    date: at(900),
    author: { type: "agent", ID: "ag9", name: "Sam Agent" },
    source: { type: "helpdesk" },
    attachments: {
      files: [{ ID: "f1", name: "endorse-policy.pdf", url: "https://files/1" }],
      isPrivate: false,
    },
    ...over,
  });

  it("classifies the message hiding behind a same-action auto-assignment, with its event ID", () => {
    const ev = classifyLastEvent([agentMsg(), autoAssign()] as any);
    expect(ev).toMatchObject({
      kind: "message",
      text: "Reply while unassigned",
      authorId: "ag9",
      eventId: "41",
    });
  });

  it("still classifies a standalone reassignment as an assignment (window refused)", () => {
    const ev = classifyLastEvent([agentMsg(), autoAssign({ date: at(30_000) })] as any);
    expect(ev).toMatchObject({ kind: "assignment", newAgent: "Sam Agent", eventId: "42" });
  });

  it("classifies the preceding message when a same-action attachment event trails it", () => {
    const ev = classifyLastEvent([agentMsg(), attachCompanion()] as any);
    expect(ev).toMatchObject({
      kind: "message",
      text: "Reply while unassigned",
      eventId: "41",
    });
  });

  it("refuses the companion path when events carry no parseable dates", () => {
    const ev = classifyLastEvent([
      agentMsg({ date: undefined }),
      autoAssign({ date: undefined }),
    ] as any);
    expect(ev).toMatchObject({ kind: "assignment", eventId: "42" });
  });

  it("notices the reply (not the assignment) to followers when a reply auto-assigns, then claims it", async () => {
    await callNotices(payload({ events: [agentMsg(), autoAssign()] }));

    expect(sendMock.mock.calls.map((c) => c[0].to).sort()).toEqual([FOLLOWER, LOOP]);
    expect(sendMock.mock.calls[0][0].body).toContain("Reply while unassigned");
    expect(isClaimedMock).toHaveBeenCalledWith(expect.anything(), "ticket-notice-T1_41");
    expect(claimReplyMock).toHaveBeenCalledWith(
      expect.anything(),
      "ticket-notice-T1_41",
      expect.stringContaining('"eventId":"41"')
    );
  });

  it("notices the reply when a trailing attachment companion follows it, then claims the message", async () => {
    await callNotices(payload({ events: [agentMsg(), attachCompanion()] }));

    expect(sendMock.mock.calls.map((c) => c[0].to).sort()).toEqual([FOLLOWER, LOOP]);
    expect(sendMock.mock.calls[0][0].body).toContain("Reply while unassigned");
    expect(isClaimedMock).toHaveBeenCalledWith(expect.anything(), "ticket-notice-T1_41");
    expect(claimReplyMock).toHaveBeenCalledWith(
      expect.anything(),
      "ticket-notice-T1_41",
      expect.stringContaining('"eventId":"41"')
    );
  });

  it("skips the whole pass when the message event is already claimed", async () => {
    isClaimedMock.mockResolvedValue(true);
    await callNotices(payload({ events: [agentMsg()] }));

    expect(sendMock).not.toHaveBeenCalled();
    expect(claimReplyMock).not.toHaveBeenCalled();
  });

  it("still sends when the claim check fails (availability over the duplicate guard)", async () => {
    isClaimedMock.mockRejectedValue(new Error("storage down"));
    await callNotices(payload({ events: [agentMsg()] }));

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(claimReplyMock).not.toHaveBeenCalled(); // no verified-unclaimed client to write with
  });

  it("does not claim when every send fails, so a redelivery can retry", async () => {
    sendMock.mockRejectedValue(new Error("graph down"));
    await callNotices(payload({ events: [agentMsg()] }));

    expect(claimReplyMock).not.toHaveBeenCalled();
  });

  it("never touches claims for message events without an ID or for non-message events", async () => {
    await callNotices(payload({ events: [agentMsg({ ID: undefined })] }));
    await callNotices(
      payload({ events: [autoAssign({ date: at(30_000) })] }) // standalone assignment notice
    );

    expect(claimClientMock).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalled();
  });
});

// #endregion
