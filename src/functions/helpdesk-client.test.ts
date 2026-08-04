// Tests for the Helpdesk client's by-shortID ticket lookup (helpdesk-client.ts). The HTTP boundary
// is mocked with axios-mock-adapter on a plain axios instance (the function takes the client as an
// argument, so createHelpdeskClient's env requirements never come into play).

import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { findTicketByShortId } from "./helpdesk-client";

describe("findTicketByShortId", () => {
  const client = axios.create({ baseURL: "https://hd.example" });
  const mock = new MockAdapter(client);

  afterEach(() => mock.reset());

  const tickets = [
    { ID: "T1", shortID: "AAA1", subject: "Other", requester: { email: "other@x.com" } },
    { ID: "T2", shortID: "AB12", subject: "Printer down", requester: { email: "jane@x.com" } },
  ];

  it("sends the shortID param and returns the client-side-verified match with requesterEmail", async () => {
    mock.onGet("/tickets").reply(200, tickets);

    const found = await findTicketByShortId(client, "AB12");

    expect(mock.history.get[0].params).toEqual({ shortID: "AB12" });
    expect(found).toEqual({
      ID: "T2",
      shortID: "AB12",
      subject: "Printer down",
      requesterEmail: "jane@x.com",
    });
  });

  it("matches case-insensitively (normalizeRef) and tolerates a missing requester", async () => {
    mock.onGet("/tickets").reply(200, [{ ID: "T3", shortID: "ab12", subject: "S" }]);

    const found = await findTicketByShortId(client, "AB12");

    expect(found).toEqual({ ID: "T3", shortID: "ab12", subject: "S", requesterEmail: null });
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
});
