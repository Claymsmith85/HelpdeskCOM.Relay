// Workflow tests for the Helpdesk webhook handler.
//
// Locks in the outbound-email decisions:
//   - tickets.create where the last event is CLIENT-authored (a customer-email-in) must NOT echo
//     an email back (the inbound worker already handled it).
//   - tickets.create where the last event is AGENT-authored DOES email the requester.
//   - tickets.update emails only on agent-authored, non-email, non-system, non-private.
//
// @azure/functions, ./graph-client, ./graph-mail and ./helpdesk-client are mocked so we can
// assert the customFields patch + the Graph sendMail without real HTTP.

jest.mock("@azure/functions", () => ({
  app: { http: jest.fn(), setup: jest.fn() },
}));
jest.mock("./graph-client", () => ({
  createGraphClientFromEnv: jest.fn().mockResolvedValue({ id: "graph" }),
}));
jest.mock("./graph-mail", () => ({
  sendMailViaGraph: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./helpdesk-client", () => ({
  createHelpdeskClient: jest.fn().mockReturnValue({ id: "helpdesk" }),
}));
// Keep the real isSystemNoteText (the system-note gate tests depend on it); only the notice
// orchestration is stubbed — its own behavior is covered by ticket-notices.test.ts.
jest.mock("./ticket-notices", () => ({
  ...jest.requireActual("./ticket-notices"),
  sendTicketNotices: jest.fn().mockResolvedValue(undefined),
}));
// Keep the real replyClaimBlobName (the send-once tests assert the claim key); the storage-backed
// operations are stubbed so no test builds a real blob client.
jest.mock("./reply-claims", () => ({
  ...jest.requireActual("./reply-claims"),
  buildReplyClaimsClient: jest.fn(),
  isReplyClaimed: jest.fn(),
  claimReply: jest.fn(),
}));

import { helpdesk } from "./helpdesk";
import { createGraphClientFromEnv } from "./graph-client";
import { sendMailViaGraph } from "./graph-mail";
import { createHelpdeskClient } from "./helpdesk-client";
import { sendTicketNotices } from "./ticket-notices";
import { buildReplyClaimsClient, claimReply, isReplyClaimed } from "./reply-claims";

const graphMock = createGraphClientFromEnv as jest.Mock;
const sendMock = sendMailViaGraph as jest.Mock;
const helpdeskClientMock = createHelpdeskClient as jest.Mock;
const noticesMock = sendTicketNotices as jest.Mock;
const claimClientMock = buildReplyClaimsClient as jest.Mock;
const isClaimedMock = isReplyClaimed as jest.Mock;
const claimReplyMock = claimReply as jest.Mock;

function fakeContext() {
  return { log: jest.fn(), invocationId: "test-inv" } as any;
}

function fakeRequest(payload: any) {
  return { json: jest.fn().mockResolvedValue(payload), body: {} } as any;
}

beforeEach(() => {
  // Submitter replies are OFF by default; most workflow tests exercise the enabled requester path.
  // The independent toggle matrix below overrides this default where needed.
  delete process.env.AGENT_NOTICES;
  delete process.env.FOLLOWERS_NOTICES;
  process.env.SUBMITTER_REPLIES = "true";
  // Send-once claim happy path: storage reachable, nothing claimed yet. (Implementations live here
  // rather than the factory because clearMocks/restoreMocks wipe them between tests.)
  claimClientMock.mockResolvedValue({ id: "storage" });
  isClaimedMock.mockResolvedValue(false);
  claimReplyMock.mockResolvedValue(true);
});

afterEach(() => {
  delete process.env.MAILBOX_ADDRESSES;
  delete process.env.SUBMITTER_REPLIES;
  delete process.env.AGENT_NOTICES;
  delete process.env.FOLLOWERS_NOTICES;
});

describe("independent webhook audience toggles", () => {
  const agentCreate = {
    eventType: "tickets.create",
    payload: {
      ID: "T1",
      shortID: "ABC",
      subject: "Customer question",
      source: { type: "email", detailedSource: "helpdesk" },
      requester: { email: "john@example.com", name: "John" },
      // The `email` custom field is RETIRED — the relay neither writes nor reads it, and the
      // recipient comes from `requester.email` above. It is kept in these fixtures on purpose:
      // tickets created before the cutover still carry the field in Helpdesk, so real payloads
      // still include it, and these cases prove the handler ignores whatever it holds (here an
      // empty string, which under the old gate would have skipped the send entirely).
      customFields: { email: "", inbox: "escape@corespecialty.com" },
      events: [
        { author: { type: "agent" }, source: { type: "api" }, message: { text: "Agent reply", isPrivate: false } },
      ],
    },
  };

  it("returns an explicit 200 without reading the payload or calling dependencies when all three are off", async () => {
    process.env.SUBMITTER_REPLIES = "false";

    const request = fakeRequest(agentCreate);
    const res = await helpdesk(request, fakeContext());

    expect(request.json).not.toHaveBeenCalled();
    expect(graphMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(noticesMock).not.toHaveBeenCalled();
    expect(res.body).toBe("Webhook audiences disabled");
    // 200 is load-bearing: a non-200 would make Helpdesk retry the webhook.
    expect(res.status).toBe(200);
  });

  it("SUBMITTER_REPLIES only emails the requester without running notices", async () => {
    await helpdesk(fakeRequest(agentCreate), fakeContext());

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].to).toBe("john@example.com");
    expect(noticesMock).not.toHaveBeenCalled();
  });

  it("FOLLOWERS_NOTICES only runs that notice audience and sends no requester email", async () => {
    process.env.SUBMITTER_REPLIES = "false";
    process.env.FOLLOWERS_NOTICES = "true";

    await helpdesk(fakeRequest(agentCreate), fakeContext());

    expect(noticesMock).toHaveBeenCalledWith(
      expect.objectContaining({ followers: true, agent: false })
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("AGENT_NOTICES only runs that notice audience and sends no requester email", async () => {
    process.env.SUBMITTER_REPLIES = "false";
    process.env.AGENT_NOTICES = "true";

    await helpdesk(fakeRequest(agentCreate), fakeContext());

    expect(noticesMock).toHaveBeenCalledWith(
      expect.objectContaining({ followers: false, agent: true })
    );
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("tickets.create from Helpdesk", () => {
  function createPayload(lastAuthorType: string, text = "message body") {
    return {
      eventType: "tickets.create",
      payload: {
        ID: "T1",
        shortID: "ABC",
        subject: "Customer question",
        source: { type: "email", detailedSource: "helpdesk" },
        requester: { email: "john@example.com", name: "John" },
        customFields: { email: "", inbox: "escape@corespecialty.com" },
        events: [
          { author: { type: lastAuthorType }, source: { type: "api" }, message: { text, isPrivate: false } },
        ],
      },
    };
  }

  it("does NOT email the requester when the create is client-authored", async () => {
    await helpdesk(fakeRequest(createPayload("client")), fakeContext());


    expect(sendMock).not.toHaveBeenCalled();
  });

  it("emails the requester when the create's last event is agent-authored", async () => {
    await helpdesk(fakeRequest(createPayload("agent", "Agent reply here")), fakeContext());

    expect(sendMock).toHaveBeenCalledTimes(1);
    const arg = sendMock.mock.calls[0][0];
    expect(arg.subject).toBe("Re: Customer question [#ABC]");
    expect(arg.to).toBe("john@example.com");
    expect(arg.mailbox).toBe("escape@corespecialty.com");
    expect(arg.body).toBe("Agent reply here");
  });

  it("does not email when the agent create message is a system note", async () => {
    await helpdesk(fakeRequest(createPayload("agent", "System note: ticket created")), fakeContext());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not email when the agent create message is private", async () => {
    const payload = createPayload("agent");
    payload.payload.events[0].message.isPrivate = true;
    await helpdesk(fakeRequest(payload), fakeContext());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not email when an agent create has no visible message text", async () => {
    await helpdesk(fakeRequest(createPayload("agent", "")), fakeContext());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not echo when the create's last event is a non-message agent event after the customer message", async () => {
    // e.g. an auto-assignment recorded inside the create payload: last event is agent-authored but
    // carries no message; the customer's message earlier in the history must not be sent back.
    const payload = createPayload("client", "Customer's own words");
    (payload.payload.events as any[]).push({
      author: { type: "agent" },
      source: { type: "api" },
      status: { old: "new", new: "open" },
    });
    await helpdesk(fakeRequest(payload), fakeContext());

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("patches but suppresses the reply when the requester is a monitored mailbox (loop guard)", async () => {
    process.env.MAILBOX_ADDRESSES = "escape@corespecialty.com";
    const payload = createPayload("agent", "Agent reply here");
    payload.payload.requester.email = "escape@corespecialty.com";
    await helpdesk(fakeRequest(payload), fakeContext());

    expect(sendMock).not.toHaveBeenCalled(); // but no echo into a drained inbox
  });
});

describe("tickets.update", () => {
  function updatePayload(over: {
    lastSourceType?: string;
    lastAuthorType?: string;
    text?: string;
    customEmail?: string | undefined;
  }) {
    const {
      lastSourceType = "api",
      lastAuthorType = "agent",
      text = "Update reply",
      customEmail = "jane@example.com",
    } = over;
    return {
      eventType: "tickets.update",
      payload: {
        ID: "T2",
        shortID: "XYZ",
        subject: "Open topic",
        source: { type: "api", detailedSource: "api" },
        requester: { email: customEmail, name: "Jane" },
        customFields: { email: customEmail, inbox: "escapereferrals@corespecialty.com" },
        // Assigned to the Escape Referrals team — the mailbox every send below must come from (a
        // live payload always carries the assignment; the sender follows it, not customFields.inbox).
        assignment: {
          team: { ID: "3a5e9d73-e5a0-442e-888b-6573672c9d05", name: "Escape Referrals" },
          agent: { ID: "a1", name: "Agent One" },
        },
        events: [
          { author: { type: lastAuthorType }, source: { type: lastSourceType }, message: { text, isPrivate: false } },
        ],
      },
    };
  }

  it("emails the requester on an agent-authored, non-email update", async () => {
    await helpdesk(fakeRequest(updatePayload({})), fakeContext());

    expect(sendMock).toHaveBeenCalledTimes(1);
    const arg = sendMock.mock.calls[0][0];
    expect(arg.subject).toBe("Re: Open topic [#XYZ]");
    expect(arg.to).toBe("jane@example.com");
    expect(arg.mailbox).toBe("escapereferrals@corespecialty.com");
    expect(arg.body).toBe("Update reply");

  });

  it("does not email when the last event came from email (already handled inbound)", async () => {
    await helpdesk(fakeRequest(updatePayload({ lastSourceType: "email" })), fakeContext());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not email when the last event is not agent-authored", async () => {
    await helpdesk(fakeRequest(updatePayload({ lastAuthorType: "client" })), fakeContext());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not email when the agent comment is a system note", async () => {
    await helpdesk(fakeRequest(updatePayload({ text: "System note: status changed" })), fakeContext());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not email when there is no requester email", async () => {
    await helpdesk(fakeRequest(updatePayload({ customEmail: "" })), fakeContext());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not email when the agent comment is a private message", async () => {
    const payload = updatePayload({});
    payload.payload.events[0].message.isPrivate = true;
    await helpdesk(fakeRequest(payload), fakeContext());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not email when there is no visible (non-private/non-system) message", async () => {
    await helpdesk(fakeRequest(updatePayload({ text: "" })), fakeContext());
    expect(sendMock).not.toHaveBeenCalled();
  });

  // The payload's events array is the ticket's FULL history, so a non-message last event always
  // arrives with the customer's older messages still in the array. These lock in that no UI action
  // (status change, reassignment, …) can fall back to that history and echo it to the requester.
  function historyUpdatePayload(lastEvent: any) {
    return {
      eventType: "tickets.update",
      payload: {
        ID: "T2",
        shortID: "XYZ",
        subject: "Open topic",
        source: { type: "api", detailedSource: "api" },
        requester: { email: "jane@example.com", name: "Jane" },
        customFields: { email: "jane@example.com", inbox: "escapereferrals@corespecialty.com" },
        events: [
          {
            author: { type: "client" },
            source: { type: "email" },
            message: { text: "Customer's own words", isPrivate: false },
          },
          lastEvent,
        ] as any[],
      },
    };
  }

  it("does not echo the customer's message on an agent status change (the message-less UI event)", async () => {
    const payload = historyUpdatePayload({
      author: { type: "agent" },
      source: { type: "api" },
      status: { old: "open", new: "solved" },
    });
    await helpdesk(fakeRequest(payload), fakeContext());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not echo the customer's message on an agent reassignment", async () => {
    const payload = historyUpdatePayload({
      author: { type: "agent" },
      source: { type: "api" },
      assignment: {
        new: { team: { ID: "t2", name: "Team Two" }, agent: { ID: "a2", name: "Agent Two" } },
        old: { team: { ID: "t1", name: "Team One" } },
      },
    });
    await helpdesk(fakeRequest(payload), fakeContext());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not re-send an older agent reply on a non-message event either", async () => {
    const payload = historyUpdatePayload({
      author: { type: "agent" },
      source: { type: "api" },
      status: { old: "open", new: "pending" },
    });
    (payload.payload.events as any[]).splice(1, 0, {
      author: { type: "agent" },
      source: { type: "api" },
      message: { text: "Yesterday's agent reply", isPrivate: false },
    });
    await helpdesk(fakeRequest(payload), fakeContext());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not email on a blank / attachments-only agent reply even with history present", async () => {
    const payload = historyUpdatePayload({
      author: { type: "agent" },
      source: { type: "api" },
      message: { text: " \n ", isPrivate: false },
      attachments: { files: [], isPrivate: false },
    });
    await helpdesk(fakeRequest(payload), fakeContext());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("still emails a real agent reply, and sends that event's own text, not the history's", async () => {
    const payload = historyUpdatePayload({
      author: { type: "agent" },
      source: { type: "api" },
      message: { text: "Fresh agent reply", isPrivate: false },
    });
    await helpdesk(fakeRequest(payload), fakeContext());

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].to).toBe("jane@example.com");
    expect(sendMock.mock.calls[0][0].body).toBe("Fresh agent reply");
  });

  it("emails when a UI reply message is followed by a trailing attachments companion event", async () => {
    helpdeskClientMock.mockReturnValueOnce({
      id: "helpdesk",
      get: jest.fn().mockResolvedValue({ data: Buffer.from("pdf-binary") }),
    });

    const payload = historyUpdatePayload({
      ID: 42,
      date: "2026-08-17T15:00:00.900Z",
      author: { type: "agent" },
      source: { type: "helpdesk" },
      attachments: {
        files: [{ ID: "f1", name: "endorse-policy.pdf", url: "https://files/1" }],
        isPrivate: false,
      },
    });
    (payload.payload.events as any[]).splice(1, 0, {
      ID: 41,
      date: "2026-08-17T15:00:00.000Z",
      author: { type: "agent" },
      source: { type: "helpdesk" },
      message: {
        text: "Please see attached.\n---\nAttachments:\n- endorse-policy.pdf",
        isPrivate: false,
      },
    });

    await helpdesk(fakeRequest(payload), fakeContext());

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].to).toBe("jane@example.com");
    expect(sendMock.mock.calls[0][0].body).toBe("Please see attached.");
    expect(sendMock.mock.calls[0][0].attachments).toEqual([
      expect.objectContaining({
        name: "endorse-policy.pdf",
        contentType: "application/octet-stream",
      }),
    ]);
  });

  it("suppresses the agent reply when the requester is a monitored mailbox (loop guard)", async () => {
    process.env.MAILBOX_ADDRESSES = "escape@corespecialty.com,escapereferrals@corespecialty.com";
    await helpdesk(
      fakeRequest(updatePayload({ customEmail: "escapereferrals@corespecialty.com" })),
      fakeContext()
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("suppresses the agent reply to a drain mailbox under its alias (UPN) company domain", async () => {
    // Mailbox configured on the UPN domain; the requester is the SAME mailbox on the alias domain.
    process.env.MAILBOX_ADDRESSES = "escape@corespecialty.com";
    await helpdesk(
      fakeRequest(updatePayload({ customEmail: "escape@corespecialtyins.com" })),
      fakeContext()
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("still emails an ordinary internal requester (non-mailbox company address)", async () => {
    process.env.MAILBOX_ADDRESSES = "escape@corespecialty.com";
    await helpdesk(fakeRequest(updatePayload({ customEmail: "bob@corespecialty.com" })), fakeContext());
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].to).toBe("bob@corespecialty.com");
  });

  it("still emails a normal external requester when monitored mailboxes are configured", async () => {
    process.env.MAILBOX_ADDRESSES = "escape@corespecialty.com";
    await helpdesk(fakeRequest(updatePayload({ customEmail: "jane@example.com" })), fakeContext());
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].to).toBe("jane@example.com");
  });

  it("never throws when Graph sendMail fails on update", async () => {
    sendMock.mockRejectedValueOnce(new Error("graph down"));
    await expect(helpdesk(fakeRequest(updatePayload({})), fakeContext())).resolves.toBeDefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe("follower / people-in-the-loop notice pass (FOLLOWERS_NOTICES)", () => {
  // A client-authored, EMAIL-sourced update: every requester gate skips it (not agent-authored,
  // and already handled inbound), which is exactly why the notice pass must run before those gates.
  function clientUpdate() {
    return {
      eventType: "tickets.update",
      payload: {
        ID: "T3",
        shortID: "QQ1",
        subject: "Loop test",
        source: { type: "api", detailedSource: "api" },
        requester: { email: "jane@example.com", name: "Jane" },
        customFields: { email: "", inbox: "escapereferrals@corespecialty.com" },
        assignment: {
          team: { ID: "3a5e9d73-e5a0-442e-888b-6573672c9d05", name: "Escape Referrals" },
          agent: { ID: "a1", name: "Agent One" },
        },
        followers: [{ ID: "ag1" }],
        cc: ["loop@example.com"],
        events: [
          { author: { type: "client" }, source: { type: "email" }, message: { text: "Customer says", isPrivate: false } },
        ],
      },
    };
  }

  it("is not invoked when FOLLOWERS_NOTICES is unset (default OFF)", async () => {
    await helpdesk(fakeRequest(clientUpdate()), fakeContext());
    expect(noticesMock).not.toHaveBeenCalled();
  });

  it("runs on updates the requester gates would skip (client-authored, email-sourced)", async () => {
    process.env.FOLLOWERS_NOTICES = "true";

    await helpdesk(fakeRequest(clientUpdate()), fakeContext());

    expect(noticesMock).toHaveBeenCalledTimes(1);
    const arg = noticesMock.mock.calls[0][0];
    expect(arg.payload.payload.ID).toBe("T3");
    expect(arg.mailbox).toBe("escapereferrals@corespecialty.com");
    expect(arg.followers).toBe(true);
    expect(arg.agent).toBe(false);
    expect(sendMock).not.toHaveBeenCalled(); // requester flow still correctly skipped
  });

  it("runs on tickets.create too, and the customFields patch still happens", async () => {
    process.env.FOLLOWERS_NOTICES = "true";
    const payload = clientUpdate() as any;
    payload.eventType = "tickets.create";
    payload.payload.source = { type: "email", detailedSource: "helpdesk" };

    await helpdesk(fakeRequest(payload), fakeContext());

    expect(noticesMock).toHaveBeenCalledTimes(1);
  });

  it("coexists with the requester email on an agent-authored update", async () => {
    process.env.FOLLOWERS_NOTICES = "true";
    const payload = clientUpdate() as any;
    payload.payload.events = [
      { author: { type: "agent" }, source: { type: "api" }, message: { text: "Agent reply", isPrivate: false } },
    ];

    await helpdesk(fakeRequest(payload), fakeContext());

    expect(noticesMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1); // requester still emailed
    expect(sendMock.mock.calls[0][0].to).toBe("jane@example.com");
  });

  it("falls back to the Escape mailbox when the ticket has no team the relay can place", async () => {
    process.env.FOLLOWERS_NOTICES = "true";
    const payload = clientUpdate() as any;
    delete payload.payload.assignment;
    delete payload.payload.customFields.inbox;

    await helpdesk(fakeRequest(payload), fakeContext());

    expect(noticesMock.mock.calls[0][0].mailbox).toBe("escape@corespecialty.com");
  });

  it("a notice-pass failure never fails the webhook or the requester email", async () => {
    process.env.FOLLOWERS_NOTICES = "true";
    noticesMock.mockRejectedValueOnce(new Error("notices down"));
    const payload = clientUpdate() as any;
    payload.payload.events = [
      { author: { type: "agent" }, source: { type: "api" }, message: { text: "Agent reply", isPrivate: false } },
    ];

    await expect(helpdesk(fakeRequest(payload), fakeContext())).resolves.toBeDefined();
    expect(sendMock).toHaveBeenCalledTimes(1); // requester email still went out
  });
});

// A reply on an unassigned (or otherwise-assigned) ticket makes Helpdesk auto-assign as part of
// the SAME action, so the webhook's events end [..., message, assignment] — the strict last-event
// anchor used to drop the reply silently (the agent had to assign themselves and resend). These
// lock in the companion-skip selection (same-action window) and the per-(ticket, event) send-once
// claim that keeps the relaxed selection from ever double-emailing the requester.
describe("same-action companion events (reply that auto-assigns / auto-changes status)", () => {
  const T0 = "2026-08-17T15:00:00.000Z";
  const at = (offsetMs: number) => new Date(Date.parse(T0) + offsetMs).toISOString();

  const agentMsg = (over: any = {}) => ({
    ID: 41,
    date: T0,
    author: { type: "agent" },
    source: { type: "api" },
    message: { text: "Reply while unassigned", isPrivate: false },
    ...over,
  });
  const autoAssign = (over: any = {}) => ({
    ID: 42,
    date: at(800),
    author: { type: "agent" },
    source: { type: "api" },
    assignment: {
      new: { team: { ID: "t1", name: "Team One" }, agent: { ID: "a1", name: "Agent One" } },
      old: { team: { ID: "t1", name: "Team One" } },
    },
    ...over,
  });
  const autoStatus = (over: any = {}) => ({
    ID: 43,
    date: at(500),
    author: { type: "agent" },
    source: { type: "api" },
    status: { old: "new", new: "open" },
    ...over,
  });
  // Older history that must never be echoed, whatever the selection does.
  const oldClientMsg = {
    ID: 7,
    date: "2026-08-16T09:00:00.000Z",
    author: { type: "client" },
    source: { type: "email" },
    message: { text: "Customer's own words", isPrivate: false },
  };

  function update(events: any[]) {
    return {
      eventType: "tickets.update",
      payload: {
        ID: "T2",
        shortID: "XYZ",
        subject: "Open topic",
        source: { type: "api", detailedSource: "api" },
        requester: { email: "jane@example.com", name: "Jane" },
        customFields: { email: "jane@example.com", inbox: "escapereferrals@corespecialty.com" },
        events,
      },
    };
  }

  it("emails the reply hiding behind a same-action auto-assignment, and claims its event", async () => {
    await helpdesk(fakeRequest(update([oldClientMsg, agentMsg(), autoAssign()])), fakeContext());

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].to).toBe("jane@example.com");
    expect(sendMock.mock.calls[0][0].body).toBe("Reply while unassigned");
    // Claimed under the MESSAGE event's id, so any later webhook meeting event 41 again skips it.
    expect(isClaimedMock).toHaveBeenCalledWith(expect.anything(), "agent-reply-T2_41");
    expect(claimReplyMock).toHaveBeenCalledWith(
      expect.anything(),
      "agent-reply-T2_41",
      expect.stringContaining('"eventId":"41"')
    );
  });

  it("also skips a same-action status companion (and several companions at once)", async () => {
    await helpdesk(
      fakeRequest(update([oldClientMsg, agentMsg(), autoStatus(), autoAssign()])),
      fakeContext()
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].body).toBe("Reply while unassigned");
  });

  it("does not send when the assignment happens outside the same-action window", async () => {
    // 30 s between message and reassignment = a human action sequence, not one atomic action.
    // The message's own webhook already delivered (and claimed) it; re-sending here would dupe.
    await helpdesk(
      fakeRequest(update([oldClientMsg, agentMsg(), autoAssign({ date: at(30_000) })])),
      fakeContext()
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("still never echoes a customer message behind a fresh assignment (echo guard with dates)", async () => {
    const clientMsg = agentMsg({ author: { type: "client" } });
    await helpdesk(fakeRequest(update([clientMsg, autoAssign()])), fakeContext());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("refuses the companion path when events carry no parseable dates (cannot prove same-action)", async () => {
    await helpdesk(
      fakeRequest(update([agentMsg({ date: undefined }), autoAssign({ date: undefined })])),
      fakeContext()
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips a message event whose reply was already sent (claim hit = redelivery/companion dedupe)", async () => {
    isClaimedMock.mockResolvedValue(true);
    await helpdesk(fakeRequest(update([oldClientMsg, agentMsg()])), fakeContext());

    expect(isClaimedMock).toHaveBeenCalledWith(expect.anything(), "agent-reply-T2_41");
    expect(sendMock).not.toHaveBeenCalled();
    expect(claimReplyMock).not.toHaveBeenCalled();
  });

  it("still sends when the claim check fails (availability over the duplicate guard)", async () => {
    isClaimedMock.mockRejectedValue(new Error("storage down"));
    await helpdesk(fakeRequest(update([oldClientMsg, agentMsg()])), fakeContext());
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("does not claim when the send itself fails, so the retry path can still deliver", async () => {
    sendMock.mockRejectedValueOnce(new Error("graph down"));
    await expect(
      helpdesk(fakeRequest(update([oldClientMsg, agentMsg()])), fakeContext())
    ).resolves.toBeDefined();
    expect(claimReplyMock).not.toHaveBeenCalled();
  });

  it("sends unguarded when the message event has no ID (no storage dependency added)", async () => {
    await helpdesk(fakeRequest(update([agentMsg({ ID: undefined })])), fakeContext());

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(claimClientMock).not.toHaveBeenCalled();
  });

  it("emails the reply on a tickets.create whose last event is the auto-assignment", async () => {
    const payload = {
      eventType: "tickets.create",
      payload: {
        ID: "T1",
        shortID: "ABC",
        subject: "Customer question",
        source: { type: "email", detailedSource: "helpdesk" },
        requester: { email: "john@example.com", name: "John" },
        customFields: { email: "", inbox: "escape@corespecialty.com" },
        events: [agentMsg(), autoAssign()],
      },
    };
    await helpdesk(fakeRequest(payload), fakeContext());

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].to).toBe("john@example.com");
    expect(sendMock.mock.calls[0][0].body).toBe("Reply while unassigned");
  });
});

// The sending mailbox follows the ticket's ASSIGNED TEAM, not customFields.inbox (which records
// where the original email landed and never changes). Without this, a ticket reassigned from Escape
// to Escape Referrals keeps answering as escape@, so the requester's reply comes back to a mailbox
// the responding team doesn't own. Resolution itself is unit-tested in reply-mailbox.test.ts; these
// lock in that the handler applies it to BOTH audiences of one delivery.
describe("sender mailbox follows the assigned team", () => {
  const TEAM_REFERRALS = "3a5e9d73-e5a0-442e-888b-6573672c9d05";
  const MB_REFERRALS = "escapereferrals@corespecialty.com";

  // Landed at escape@ (customFields.inbox), since reassigned to the Escape Referrals team.
  function reassignedUpdate(over: any = {}) {
    return {
      eventType: "tickets.update",
      payload: {
        ID: "T9",
        shortID: "RE1",
        subject: "Reassigned topic",
        source: { type: "api", detailedSource: "api" },
        requester: { email: "jane@example.com", name: "Jane" },
        customFields: { email: "jane@example.com", inbox: "escape@corespecialty.com" },
        assignment: { team: { ID: TEAM_REFERRALS, name: "Escape Referrals" }, agent: { ID: "a1", name: "A" } },
        followers: [{ ID: "ag1" }],
        cc: ["loop@example.com"],
        events: [
          { ID: 91, author: { type: "agent" }, source: { type: "api" }, message: { text: "Agent reply", isPrivate: false } },
        ],
        ...over,
      },
    };
  }

  it("sends the requester reply as the assigned team's mailbox, not the recorded inbox", async () => {
    await helpdesk(fakeRequest(reassignedUpdate()), fakeContext());

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].mailbox).toBe(MB_REFERRALS);
    expect(sendMock.mock.calls[0][0].to).toBe("jane@example.com");
  });

  it("uses the same mailbox for the notice audiences in that delivery", async () => {
    process.env.FOLLOWERS_NOTICES = "true";
    process.env.AGENT_NOTICES = "true";

    await helpdesk(fakeRequest(reassignedUpdate()), fakeContext());

    expect(noticesMock.mock.calls[0][0].mailbox).toBe(MB_REFERRALS);
    expect(sendMock.mock.calls[0][0].mailbox).toBe(MB_REFERRALS);
  });

  it("follows a reassignment recorded only in the event history", async () => {
    // No assignment snapshot on the payload; the reassignment event is the evidence.
    const payload = reassignedUpdate({ assignment: null }) as any;
    payload.payload.events = [
      {
        ID: 90,
        author: { type: "agent" },
        source: { type: "api" },
        assignment: {
          new: { team: { ID: TEAM_REFERRALS, name: "Escape Referrals" }, agent: { ID: "a1", name: "A" } },
          old: { team: { ID: "3db812da-2055-436f-9889-7073b5e976f4", name: "Escape" } },
        },
      },
      { ID: 91, author: { type: "agent" }, source: { type: "api" }, message: { text: "Agent reply", isPrivate: false } },
    ];

    await helpdesk(fakeRequest(payload), fakeContext());

    expect(sendMock.mock.calls[0][0].mailbox).toBe(MB_REFERRALS);
  });

  it("falls back to the Escape mailbox when the assigned team owns no mailbox", async () => {
    const payload = reassignedUpdate({
      assignment: { team: { ID: "4533d6c2-98fc-4563-855a-c5205f4c856d", name: "Mgmt. Team" }, agent: { ID: "a1", name: "A" } },
      customFields: { email: "jane@example.com", inbox: "escapeendorsements@corespecialty.com" },
    });

    await helpdesk(fakeRequest(payload), fakeContext());

    expect(sendMock.mock.calls[0][0].mailbox).toBe("escape@corespecialty.com");
  });

  it("sends the create-branch reply as the assigned team's mailbox too", async () => {
    const payload = reassignedUpdate() as any;
    payload.eventType = "tickets.create";
    payload.payload.source = { type: "email", detailedSource: "helpdesk" };

    await helpdesk(fakeRequest(payload), fakeContext());

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].mailbox).toBe(MB_REFERRALS);
  });
});
