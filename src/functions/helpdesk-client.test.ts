// Tests for the Helpdesk REST client + ticket operations (helpdesk-client.ts). The ticket
// ops take an AxiosInstance, so a mock-adapter instance is passed directly. No
// @azure/functions side effects here.

import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import {
  createHelpdeskClient,
  createTicket,
  updateTicketMessage,
  patchCustomFields,
  getTicketShortId,
  findExistingTicket,
  listAgents,
  listTeams,
  inviteAgent,
  updateAgentTeams,
  deleteAgent,
} from "./helpdesk-client";

describe("createHelpdeskClient", () => {
  afterEach(() => delete process.env.HELPDESK_PAT);

  it("builds a client with the default base URL and Basic auth", () => {
    process.env.HELPDESK_PAT = "pat-token";
    const client = createHelpdeskClient();
    expect(client.defaults.baseURL).toBe("https://api.helpdesk.com/v1");
  });

  it("throws when HELPDESK_PAT is missing", () => {
    delete process.env.HELPDESK_PAT;
    expect(() => createHelpdeskClient()).toThrow(/HELPDESK_PAT/);
  });
});

describe("ticket operations", () => {
  let helpdesk: ReturnType<typeof axios.create>;
  let mock: MockAdapter;

  beforeEach(() => {
    helpdesk = axios.create();
    mock = new MockAdapter(helpdesk);
  });
  afterEach(() => mock.restore());

  it("createTicket posts the expected body and returns the ID", async () => {
    mock.onPost("/tickets").reply(200, { ID: "T9" });
    const id = await createTicket({
      helpdesk,
      subject: "Need help",
      requesterEmail: "john=example.com@hash",
      requesterName: "John",
      teamId: "TEAM1",
      messageText: "body",
      customFields: { email: "john@example.com", inbox: "escape@corespecialty.com" },
    });
    expect(id).toBe("T9");
    const body = JSON.parse(mock.history.post[0].data);
    expect(body.subject).toBe("Need help");
    expect(body.requester.email).toBe("john=example.com@hash");
    expect(body.assignment.team.ID).toBe("TEAM1");
    expect(body.author.type).toBe("client");
    expect(body.customFields.email).toBe("john@example.com");
  });

  it("createTicket throws when no ID is returned", async () => {
    mock.onPost("/tickets").reply(200, {});
    await expect(
      createTicket({
        helpdesk, subject: "s", requesterEmail: "r", requesterName: "n",
        teamId: "t", messageText: "m",
      })
    ).rejects.toThrow(/no ticket ID/i);
  });

  it("updateTicketMessage patches a message + author", async () => {
    mock.onPatch("/tickets/T1").reply(200, {});
    await updateTicketMessage({ helpdesk, ticketId: "T1", text: "hello", authorType: "agent" });
    const body = JSON.parse(mock.history.patch[0].data);
    expect(body.message.text).toBe("hello");
    expect(body.author.type).toBe("agent");
  });

  it("patchCustomFields patches only customFields (no message/author)", async () => {
    mock.onPatch("/tickets/T1").reply(200, {});
    await patchCustomFields(helpdesk, "T1", { email: "john@example.com" });
    const body = JSON.parse(mock.history.patch[0].data);
    expect(body).toEqual({ customFields: { email: "john@example.com" } });
  });

  it("getTicketShortId returns the shortID, or throws when missing", async () => {
    mock.onGet("/tickets/T1").reply(200, { shortID: "ABC" });
    await expect(getTicketShortId(helpdesk, "T1")).resolves.toBe("ABC");

    mock.onGet("/tickets/T2").reply(200, {});
    await expect(getTicketShortId(helpdesk, "T2")).rejects.toThrow(/shortID missing/i);
  });
});

describe("agent / team operations", () => {
  let helpdesk: ReturnType<typeof axios.create>;
  let mock: MockAdapter;

  beforeEach(() => {
    helpdesk = axios.create();
    mock = new MockAdapter(helpdesk);
  });
  afterEach(() => mock.restore());

  it("listAgents returns the bare array (and [] when empty)", async () => {
    mock.onGet("/agents").reply(200, [
      { ID: "a1", email: "j@x.com", roles: ["normal"], teamIDs: ["T1"], status: "active" },
    ]);
    const agents = await listAgents(helpdesk);
    expect(agents).toHaveLength(1);
    expect(agents[0].teamIDs).toEqual(["T1"]);

    mock.onGet("/agents").reply(200, undefined);
    expect(await listAgents(helpdesk)).toEqual([]);
  });

  it("listTeams returns the bare array", async () => {
    mock.onGet("/teams").reply(200, [{ ID: "T1", name: "Escape" }]);
    expect(await listTeams(helpdesk)).toEqual([{ ID: "T1", name: "Escape" }]);
  });

  it("inviteAgent posts roles/teamIDs/status and returns the new ID", async () => {
    mock.onPost("/agents").reply(200, { ID: "a9" });
    const id = await inviteAgent({
      helpdesk,
      email: "new@x.com",
      name: "New Person",
      roles: ["normal"],
      teamIDs: ["T1", "T2"],
    });
    expect(id).toBe("a9");
    const body = JSON.parse(mock.history.post[0].data);
    expect(body.email).toBe("new@x.com");
    expect(body.roles).toEqual(["normal"]);
    expect(body.teamIDs).toEqual(["T1", "T2"]);
    expect(body.status).toBe("invited"); // default
  });

  it("inviteAgent throws when no ID is returned", async () => {
    mock.onPost("/agents").reply(200, {});
    await expect(
      inviteAgent({ helpdesk, email: "n@x.com", name: "n", roles: ["normal"], teamIDs: ["T1"] })
    ).rejects.toThrow(/no agent ID/i);
  });

  it("updateAgentTeams patches only teamIDs", async () => {
    mock.onPatch("/agents/a1").reply(200, {});
    await updateAgentTeams(helpdesk, "a1", ["T1", "T3"]);
    const body = JSON.parse(mock.history.patch[0].data);
    expect(body).toEqual({ teamIDs: ["T1", "T3"] });
  });

  it("deleteAgent issues DELETE on the agent", async () => {
    mock.onDelete("/agents/a1").reply(200, "OK");
    await deleteAgent(helpdesk, "a1");
    expect(mock.history.delete[0].url).toBe("/agents/a1");
  });
});

describe("findExistingTicket", () => {
  const tickets = [
    { ID: "1", shortID: "ABC", subject: "Billing question" },
    { ID: "2", shortID: "XYZ", subject: "Login help" },
  ];

  it("prefers a match on the embedded [#shortID] tag", () => {
    expect(findExistingTicket("Re: anything at all [#XYZ]", tickets)?.ID).toBe("2");
  });
  it("matches the tag case-insensitively", () => {
    expect(findExistingTicket("Re: [#xyz]", tickets)?.ID).toBe("2");
  });
  it("falls back to subject containment when no tag matches", () => {
    expect(findExistingTicket("RE: Billing question about March", tickets)?.ID).toBe("1");
  });
  it("prefers the tag over a subject-substring match", () => {
    expect(findExistingTicket("Billing question [#XYZ]", tickets)?.ID).toBe("2");
  });
  it("never matches a ticket with an empty subject", () => {
    const withEmpty = [
      { ID: "9", shortID: "EMP", subject: "" },
      { ID: "1", shortID: "ABC", subject: "Login help" },
    ];
    expect(findExistingTicket("please Login help now", withEmpty)?.ID).toBe("1");
  });
  it("does not let a very short, generic ticket subject act as a catch-all", () => {
    const shortSubjects = [
      { ID: "9", shortID: "HLP", subject: "Help" }, // 4 chars -> below the substring threshold
      { ID: "8", shortID: "BUG", subject: "Bug" },
    ];
    // Unrelated emails that merely CONTAIN the short word must not misthread into these tickets.
    expect(findExistingTicket("Help me reset my billing password", shortSubjects)).toBeNull();
    expect(findExistingTicket("Found a bug in the export", shortSubjects)).toBeNull();
  });
  it("still matches a short subject when the [#shortID] tag is present", () => {
    const shortSubjects = [{ ID: "9", shortID: "HLP", subject: "Help" }];
    expect(findExistingTicket("Re: Help [#HLP]", shortSubjects)?.ID).toBe("9");
  });
  it("returns null for an empty inbound subject", () => {
    expect(findExistingTicket("", tickets)).toBeNull();
  });
  it("returns null when nothing matches", () => {
    expect(findExistingTicket("totally unrelated", tickets)).toBeNull();
  });
});
