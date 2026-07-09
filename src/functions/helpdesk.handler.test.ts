// Workflow tests for the Helpdesk webhook handler.
//
// Locks in the outbound-email decisions:
//   - tickets.create where the last event is CLIENT-authored (a customer-email-in) patches
//     customFields but must NOT echo an email back (the inbound worker already handled it).
//   - tickets.create where the last event is AGENT-authored DOES email the requester.
//   - tickets.update emails only on agent-authored, non-email, non-system, non-private.
//
// @azure/functions, ./graph-client, ./graph-mail and ./helpdesk-client are mocked so we can
// assert the customFields patch + the Graph sendMail without real HTTP. requester-hash is real.

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

import { helpdesk } from "./helpdesk";
import { sendMailViaGraph } from "./graph-mail";
import { patchCustomFields } from "./helpdesk-client";

const INBOUND = "core-parser-01.corespecialty.com";
const sendMock = sendMailViaGraph as jest.Mock;
const patchMock = patchCustomFields as jest.Mock;

function fakeContext() {
  return { log: jest.fn(), invocationId: "test-inv" } as any;
}

function fakeRequest(payload: any) {
  return { json: async () => payload, body: {} } as any;
}

beforeEach(() => {
  process.env.RELAY_HASH_DOMAIN = INBOUND;
  // Ticketing is OFF by default; these tests exercise enabled behavior. Disabled path has its own test.
  process.env.TICKETING_TOGGLE = "true";
});

afterEach(() => {
  delete process.env.RELAY_HASH_DOMAIN;
  delete process.env.MAILBOX_ADDRESSES;
  delete process.env.TICKETING_TOGGLE;
});

describe("TICKETING_TOGGLE (master mail-flow switch)", () => {
  const agentCreate = {
    eventType: "tickets.create",
    payload: {
      ID: "T1",
      shortID: "ABC",
      subject: "Customer question",
      source: { type: "email", detailedSource: "helpdesk" },
      requester: { email: `john=example.com@${INBOUND}`, name: "John" },
      customFields: { email: "", inbox: "escape@corespecialty.com" },
      events: [
        { author: { type: "agent" }, source: { type: "api" }, message: { text: "Agent reply", isPrivate: false } },
      ],
    },
  };

  it("does nothing (no patch, no email) when the toggle is off, and returns a body", async () => {
    process.env.TICKETING_TOGGLE = "false";

    const res = await helpdesk(fakeRequest(agentCreate), fakeContext());

    expect(patchMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(res.body).toBe("Ticketing disabled");
    // 200 is load-bearing: a non-200 would make Helpdesk retry the webhook.
    expect(res.status).toBe(200);
  });

  it("does nothing when the toggle is unset (default OFF)", async () => {
    delete process.env.TICKETING_TOGGLE;

    await helpdesk(fakeRequest(agentCreate), fakeContext());

    expect(patchMock).not.toHaveBeenCalled();
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
        requester: { email: `john=example.com@${INBOUND}`, name: "John" },
        customFields: { email: "", inbox: "escape@corespecialty.com" },
        events: [
          { author: { type: lastAuthorType }, source: { type: "api" }, message: { text, isPrivate: false } },
        ],
      },
    };
  }

  it("patches customFields.email (decoded) but does NOT email when client-authored", async () => {
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

  it("patches but suppresses the reply when the decoded requester is a monitored mailbox (loop guard)", async () => {
    process.env.MAILBOX_ADDRESSES = "escape@corespecialty.com";
    const payload = createPayload("agent", "Agent reply here");
    payload.payload.requester.email = `escape=corespecialty.com@${INBOUND}`; // decodes to escape@corespecialty.com
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
