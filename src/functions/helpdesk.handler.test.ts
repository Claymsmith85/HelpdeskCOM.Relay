// Workflow tests for the Helpdesk webhook handler.
//
// Locks in the outbound-email decisions:
//   - tickets.create where the last event is CLIENT-authored (a customer-email-in) patches
//     customFields but must NOT echo an email back (the inbound worker already handled it).
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
  patchCustomFields: jest.fn().mockResolvedValue(undefined),
}));
// Keep the real isSystemNoteText (the system-note gate tests depend on it); only the notice
// orchestration is stubbed — its own behavior is covered by ticket-notices.test.ts.
jest.mock("./ticket-notices", () => ({
  ...jest.requireActual("./ticket-notices"),
  sendTicketNotices: jest.fn().mockResolvedValue(undefined),
}));

import { helpdesk } from "./helpdesk";
import { createGraphClientFromEnv } from "./graph-client";
import { sendMailViaGraph } from "./graph-mail";
import { patchCustomFields } from "./helpdesk-client";
import { sendTicketNotices } from "./ticket-notices";

const graphMock = createGraphClientFromEnv as jest.Mock;
const sendMock = sendMailViaGraph as jest.Mock;
const patchMock = patchCustomFields as jest.Mock;
const noticesMock = sendTicketNotices as jest.Mock;

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
    expect(patchMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(noticesMock).not.toHaveBeenCalled();
    expect(res.body).toBe("Webhook audiences disabled");
    // 200 is load-bearing: a non-200 would make Helpdesk retry the webhook.
    expect(res.status).toBe(200);
  });

  it("SUBMITTER_REPLIES only patches and emails the requester without running notices", async () => {
    await helpdesk(fakeRequest(agentCreate), fakeContext());

    expect(patchMock).toHaveBeenCalledWith(
      expect.anything(),
      "T1",
      { email: "john@example.com" }
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].to).toBe("john@example.com");
    expect(noticesMock).not.toHaveBeenCalled();
  });

  it("FOLLOWERS_NOTICES only runs that notice audience, patches creates, and sends no requester email", async () => {
    process.env.SUBMITTER_REPLIES = "false";
    process.env.FOLLOWERS_NOTICES = "true";

    await helpdesk(fakeRequest(agentCreate), fakeContext());

    expect(noticesMock).toHaveBeenCalledWith(
      expect.objectContaining({ followers: true, agent: false })
    );
    expect(patchMock).toHaveBeenCalledWith(
      expect.anything(),
      "T1",
      { email: "john@example.com" }
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("AGENT_NOTICES only runs that notice audience, patches creates, and sends no requester email", async () => {
    process.env.SUBMITTER_REPLIES = "false";
    process.env.AGENT_NOTICES = "true";

    await helpdesk(fakeRequest(agentCreate), fakeContext());

    expect(noticesMock).toHaveBeenCalledWith(
      expect.objectContaining({ followers: false, agent: true })
    );
    expect(patchMock).toHaveBeenCalledWith(
      expect.anything(),
      "T1",
      { email: "john@example.com" }
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

  it("patches customFields.email from the requester but does NOT email when client-authored", async () => {
    await helpdesk(fakeRequest(createPayload("client")), fakeContext());

    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock.mock.calls[0][1]).toBe("T1");
    expect(patchMock.mock.calls[0][2]).toEqual({ email: "john@example.com" });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("emails the requester when the create's last event is agent-authored", async () => {
    await helpdesk(fakeRequest(createPayload("agent", "Agent reply here")), fakeContext());

    expect(patchMock).toHaveBeenCalledTimes(1);
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

  it("patches customFields but does not email when the agent create message is private", async () => {
    const payload = createPayload("agent");
    payload.payload.events[0].message.isPrivate = true;
    await helpdesk(fakeRequest(payload), fakeContext());
    expect(patchMock).toHaveBeenCalledTimes(1);
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

    expect(patchMock).toHaveBeenCalledTimes(1); // customFields patch still runs
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("patches but suppresses the reply when the requester is a monitored mailbox (loop guard)", async () => {
    process.env.MAILBOX_ADDRESSES = "escape@corespecialty.com";
    const payload = createPayload("agent", "Agent reply here");
    payload.payload.requester.email = "escape@corespecialty.com";
    await helpdesk(fakeRequest(payload), fakeContext());

    expect(patchMock).toHaveBeenCalledTimes(1); // customFields still patched
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
        requester: { email: "jane@example.com", name: "Jane" },
        customFields: { email: customEmail, inbox: "escapereferrals@corespecialty.com" },
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

    expect(patchMock).not.toHaveBeenCalled(); // no create branch ran
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

  it("does not email when there is no requester email in custom fields", async () => {
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
  // A client-authored, EMAIL-sourced update with no customFields.email: every requester gate
  // skips it, which is exactly why the notice pass must run before those gates.
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

  it("runs on updates the requester gates would skip (client-authored, email-sourced, no customFields.email)", async () => {
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
    expect(patchMock).toHaveBeenCalledTimes(1);
  });

  it("coexists with the requester email on an agent-authored update", async () => {
    process.env.FOLLOWERS_NOTICES = "true";
    const payload = clientUpdate() as any;
    payload.payload.customFields.email = "jane@example.com";
    payload.payload.events = [
      { author: { type: "agent" }, source: { type: "api" }, message: { text: "Agent reply", isPrivate: false } },
    ];

    await helpdesk(fakeRequest(payload), fakeContext());

    expect(noticesMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1); // requester still emailed
    expect(sendMock.mock.calls[0][0].to).toBe("jane@example.com");
  });

  it("falls back to the default inbox when customFields has no inbox", async () => {
    process.env.FOLLOWERS_NOTICES = "true";
    const payload = clientUpdate() as any;
    delete payload.payload.customFields.inbox;

    await helpdesk(fakeRequest(payload), fakeContext());

    expect(noticesMock.mock.calls[0][0].mailbox).toBe("escape@corespecialty.com");
  });

  it("a notice-pass failure never fails the webhook or the requester email", async () => {
    process.env.FOLLOWERS_NOTICES = "true";
    noticesMock.mockRejectedValueOnce(new Error("notices down"));
    const payload = clientUpdate() as any;
    payload.payload.customFields.email = "jane@example.com";
    payload.payload.events = [
      { author: { type: "agent" }, source: { type: "api" }, message: { text: "Agent reply", isPrivate: false } },
    ];

    await expect(helpdesk(fakeRequest(payload), fakeContext())).resolves.toBeDefined();
    expect(sendMock).toHaveBeenCalledTimes(1); // requester email still went out
  });
});
