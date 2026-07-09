// Tests for ensureSubscriptions (subscriptions.ts) — focuses on per-mailbox isolation: one bad
// mailbox must not starve the others of create/renew, and ANY failure must still surface (throw)
// after every mailbox is attempted. The Graph client is mocked at the module boundary.

jest.mock("./graph-client", () => ({
  createGraphClientFromEnv: jest.fn(),
}));

import { createGraphClientFromEnv } from "./graph-client";
import { ensureSubscriptions, inboxResource, notificationUrlForMailbox } from "./subscriptions";

const NOTIFY_URL = "https://notify.example/api/notify?subscription-key=k";
const urlFor = (mailbox: string) => notificationUrlForMailbox(NOTIFY_URL, mailbox);

function fakeGraph(over: Partial<{ get: any; patch: any; post: any; delete: any }> = {}) {
  return {
    get: jest.fn().mockResolvedValue({ data: { value: [] } }),
    patch: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn().mockResolvedValue({ data: {} }),
    delete: jest.fn().mockResolvedValue({ data: {} }),
    ...over,
  };
}

beforeEach(() => {
  process.env.GRAPH_NOTIFICATION_URL = NOTIFY_URL;
  process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE = "client-state";
});

afterEach(() => {
  delete process.env.GRAPH_NOTIFICATION_URL;
  delete process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE;
  delete process.env.MAILBOX_ADDRESSES;
});

describe("ensureSubscriptions", () => {
  it("creates a per-mailbox subscription (mailbox carried in the notificationUrl) for each mailbox", async () => {
    const graph = fakeGraph();
    (createGraphClientFromEnv as jest.Mock).mockResolvedValue(graph);
    process.env.MAILBOX_ADDRESSES = "a@x.com,b@x.com";

    const res = await ensureSubscriptions();

    expect(res).toEqual({ created: 2, renewed: 0, failed: 0, mailboxes: 2 });
    expect(graph.post).toHaveBeenCalledTimes(2);
    expect(graph.post).toHaveBeenCalledWith(
      "/subscriptions",
      expect.objectContaining({ notificationUrl: urlFor("a@x.com"), resource: inboxResource("a@x.com") })
    );
    // The address is URL-encoded in the param.
    expect(urlFor("a@x.com")).toBe(`${NOTIFY_URL}&mailbox=a%40x.com`);
    expect(graph.patch).not.toHaveBeenCalled();
  });

  it("renews a matching per-mailbox subscription (PATCH) and creates the rest", async () => {
    const existing = [
      {
        id: "S1",
        resource: inboxResource("a@x.com"),
        notificationUrl: urlFor("a@x.com"),
        expirationDateTime: "2026-01-01T00:00:00Z",
      },
    ];
    const graph = fakeGraph({ get: jest.fn().mockResolvedValue({ data: { value: existing } }) });
    (createGraphClientFromEnv as jest.Mock).mockResolvedValue(graph);
    process.env.MAILBOX_ADDRESSES = "a@x.com,b@x.com";

    const res = await ensureSubscriptions();

    expect(res).toEqual({ created: 1, renewed: 1, failed: 0, mailboxes: 2 });
    expect(graph.patch).toHaveBeenCalledWith(
      "/subscriptions/S1",
      expect.objectContaining({ expirationDateTime: expect.any(String) })
    );
    expect(graph.post).toHaveBeenCalledTimes(1);
    expect(graph.delete).not.toHaveBeenCalled();
  });

  it("migrates a stale base-URL subscription: creates the per-mailbox one and deletes the stale", async () => {
    const existing = [
      {
        id: "OLD",
        resource: inboxResource("a@x.com"),
        notificationUrl: NOTIFY_URL, // pre-change: no mailbox param
        expirationDateTime: "2026-01-01T00:00:00Z",
      },
    ];
    const graph = fakeGraph({ get: jest.fn().mockResolvedValue({ data: { value: existing } }) });
    (createGraphClientFromEnv as jest.Mock).mockResolvedValue(graph);
    process.env.MAILBOX_ADDRESSES = "a@x.com";

    const res = await ensureSubscriptions();

    expect(res).toEqual({ created: 1, renewed: 0, failed: 0, mailboxes: 1 });
    expect(graph.post).toHaveBeenCalledWith(
      "/subscriptions",
      expect.objectContaining({ notificationUrl: urlFor("a@x.com") })
    );
    expect(graph.delete).toHaveBeenCalledWith("/subscriptions/OLD");
  });

  it("does NOT delete a same-inbox subscription pointing at a different base URL (another environment)", async () => {
    const existing = [
      {
        id: "OTHER-ENV",
        resource: inboxResource("a@x.com"),
        notificationUrl: "https://other.example/api/notify?subscription-key=z&mailbox=a%40x.com",
        expirationDateTime: "2026-01-01T00:00:00Z",
      },
    ];
    const graph = fakeGraph({ get: jest.fn().mockResolvedValue({ data: { value: existing } }) });
    (createGraphClientFromEnv as jest.Mock).mockResolvedValue(graph);
    process.env.MAILBOX_ADDRESSES = "a@x.com";

    const res = await ensureSubscriptions();

    expect(res).toEqual({ created: 1, renewed: 0, failed: 0, mailboxes: 1 });
    expect(graph.delete).not.toHaveBeenCalled(); // the other env's subscription is preserved
  });

  it("isolates a failing mailbox: still attempts the rest, then throws", async () => {
    const graph = fakeGraph({
      post: jest.fn().mockImplementation((_url: string, body: any) =>
        body.resource.includes("b@x.com")
          ? Promise.reject(new Error("boom"))
          : Promise.resolve({ data: {} })
      ),
    });
    (createGraphClientFromEnv as jest.Mock).mockResolvedValue(graph);
    process.env.MAILBOX_ADDRESSES = "a@x.com,b@x.com,c@x.com";

    await expect(ensureSubscriptions()).rejects.toThrow(/1 of 3 mailbox\(es\) failed/);
    // All three were attempted despite b failing in the middle.
    expect(graph.post).toHaveBeenCalledTimes(3);
  });
});
