// Tests for the Helpdesk client's by-shortID ticket lookup (helpdesk-client.ts). The HTTP boundary
// is mocked with axios-mock-adapter on a plain axios instance (the function takes the client as an
// argument, so createHelpdeskClient's env requirements never come into play).

import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { createHelpdeskClient, findTicketByShortId } from "./helpdesk-client";
import { formatAxiosError } from "./logging";

describe("createHelpdeskClient wiring", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.HELPDESK_PAT;
    delete process.env.HELPDESK_RATE_LIMIT_RPS;
  });

  it("attaches its interceptors only once when axios.create returns a shared instance", async () => {
    process.env.HELPDESK_PAT = "pat-token";
    process.env.HELPDESK_RATE_LIMIT_RPS = "100000";
    const shared = axios.create();
    const mock = new MockAdapter(shared);
    jest.spyOn(axios, "create").mockReturnValue(shared);

    expect(createHelpdeskClient()).toBe(shared);
    expect(createHelpdeskClient()).toBe(shared);
    expect((shared.interceptors.request as any).handlers).toHaveLength(1);
    expect((shared.interceptors.response as any).handlers).toHaveLength(1);

    mock.onGet("/x").reply(200, { ok: true });
    await expect(shared.get("/x")).resolves.toMatchObject({ data: { ok: true } });

    mock.onGet("/failure").reply(404);
    const error = await shared.get("/failure").catch((e) => e);
    expect(formatAxiosError(error)).toMatchObject({
      api: "Helpdesk",
      retries: 0,
      status: 404,
      message: expect.stringContaining("[Helpdesk API]"),
    });
    mock.restore();
  });
});

describe("findTicketByShortId", () => {
  const client = axios.create({ baseURL: "https://hd.example" });
  const mock = new MockAdapter(client);

  afterEach(() => mock.reset());

  const tickets = [
    { ID: "T1", shortID: "AAA1", subject: "Other", requester: { email: "other@x.com" } },
    {
      ID: "T2",
      shortID: "AB12",
      subject: "Printer down",
      requester: { email: "jane@x.com" },
      cc: [{ email: "Tommy.K@x.com", name: null }], // live shape
      followers: ["ag-1"], // live shape: bare agent IDs
    },
  ];

  it("sends the shortID param and returns the verified match with its audience fields", async () => {
    mock.onGet("/tickets").reply(200, tickets);

    const found = await findTicketByShortId(client, "AB12");

    expect(mock.history.get[0].params).toEqual({ shortID: "AB12" });
    expect(found).toEqual({
      ID: "T2",
      shortID: "AB12",
      subject: "Printer down",
      requesterEmail: "jane@x.com",
      ccEmails: ["tommy.k@x.com"],
      followerIds: ["ag-1"],
    });
  });

  it("matches case-insensitively (normalizeRef) and tolerates missing requester/cc/followers", async () => {
    mock.onGet("/tickets").reply(200, [{ ID: "T3", shortID: "ab12", subject: "S" }]);

    const found = await findTicketByShortId(client, "AB12");

    expect(found).toEqual({
      ID: "T3",
      shortID: "ab12",
      subject: "S",
      requesterEmail: null,
      ccEmails: [],
      followerIds: [],
    });
  });

  it("returns null when the response holds no matching shortID (filter ignored by the API)", async () => {
    mock.onGet("/tickets").reply(200, [tickets[0]]);

    await expect(findTicketByShortId(client, "AB12")).resolves.toBeNull();
  });

  it("returns null on a definitive 4xx (fall through to new-ticket behavior)", async () => {
    mock.onGet("/tickets").reply(400, { error: "bad filter" });

    await expect(findTicketByShortId(client, "AB12")).resolves.toBeNull();
  });

  it("rethrows on a 5xx and on a network error (queue retry, never mis-thread)", async () => {
    mock.onGet("/tickets").reply(500);
    await expect(findTicketByShortId(client, "AB12")).rejects.toThrow();

    mock.reset();
    mock.onGet("/tickets").networkError();
    await expect(findTicketByShortId(client, "AB12")).rejects.toThrow();
  });

  it("rethrows on TRANSIENT 429/408 — a rate-limit is not a 'no such ticket'", async () => {
    mock.onGet("/tickets").reply(429);
    await expect(findTicketByShortId(client, "AB12")).rejects.toThrow();

    mock.reset();
    mock.onGet("/tickets").reply(408);
    await expect(findTicketByShortId(client, "AB12")).rejects.toThrow();
  });
});
