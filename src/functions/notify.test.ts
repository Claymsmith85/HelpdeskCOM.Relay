// Tests for the Graph change-notification receiver (notify.ts):
//   - validationToken handshake echoes the token as text/plain (200)
//   - clientState is validated; mismatches are dropped
//   - well-formed notifications enqueue { mailbox, messageId }
//
// notify.ts calls output.storageQueue(...) and app.http(...) at module load, so
// @azure/functions is mocked to a no-op registry.

const QUEUE_BINDING = { __binding: "queue" };
jest.mock("@azure/functions", () => ({
  app: { http: jest.fn(), setup: jest.fn() },
  output: { storageQueue: jest.fn(() => QUEUE_BINDING) },
}));

import { notify, parseResource } from "./notify";

function fakeRequest(opts: { query?: Record<string, string>; body?: any }) {
  return {
    query: new URLSearchParams(opts.query ?? {}),
    json: async () => {
      if (opts.body === undefined) throw new Error("no body");
      return opts.body;
    },
  } as any;
}

function fakeContext() {
  return { log: jest.fn(), invocationId: "test-inv", extraOutputs: { set: jest.fn() } } as any;
}

describe("validation handshake", () => {
  it("echoes the validationToken as text/plain", async () => {
    const res = await notify(fakeRequest({ query: { validationToken: "abc123" } }), fakeContext());
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ "Content-Type": "text/plain" });
    expect(res.body).toBe("abc123");
  });
});

describe("parseResource", () => {
  it("extracts mailbox + messageId, preferring resourceData.id", () => {
    expect(
      parseResource({ resource: "Users/MB-GUID/Messages/AAA", resourceData: { id: "MSG-1" } })
    ).toEqual({ mailbox: "MB-GUID", messageId: "MSG-1" });
  });
  it("falls back to the resource path message id", () => {
    expect(parseResource({ resource: "users/mb/messages/m2" })).toEqual({ mailbox: "mb", messageId: "m2" });
  });
  it("returns null for an unparseable resource", () => {
    expect(parseResource({ resource: "Users/mb/events/x" })).toBeNull();
  });
});

describe("notification enqueue", () => {
  afterEach(() => delete process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE);

  it("enqueues a well-formed notification with a matching clientState", async () => {
    process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE = "secret";
    const ctx = fakeContext();
    const res = await notify(
      fakeRequest({
        body: {
          value: [
            {
              clientState: "secret",
              resource: "Users/MB/Messages/M9",
              resourceData: { id: "M9" },
            },
          ],
        },
      }),
      ctx
    );

    expect(res.status).toBe(202);
    expect(ctx.extraOutputs.set).toHaveBeenCalledTimes(1);
    const [binding, messages] = (ctx.extraOutputs.set as jest.Mock).mock.calls[0];
    expect(binding).toBe(QUEUE_BINDING);
    expect(JSON.parse(messages[0])).toEqual({ mailbox: "MB", messageId: "M9" });
  });

  it("prefers the mailbox from the notificationUrl query param over the resource GUID", async () => {
    process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE = "secret";
    const ctx = fakeContext();
    const res = await notify(
      fakeRequest({
        query: { mailbox: "ureferrals@corespecialtyins.com" },
        body: {
          value: [
            { clientState: "secret", resource: "Users/MB-GUID/Messages/M9", resourceData: { id: "M9" } },
          ],
        },
      }),
      ctx
    );

    expect(res.status).toBe(202);
    const [, messages] = (ctx.extraOutputs.set as jest.Mock).mock.calls[0];
    expect(JSON.parse(messages[0])).toEqual({
      mailbox: "ureferrals@corespecialtyins.com",
      messageId: "M9",
    });
  });

  it("drops notifications with a mismatched clientState", async () => {
    process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE = "secret";
    const ctx = fakeContext();
    const res = await notify(
      fakeRequest({
        body: { value: [{ clientState: "WRONG", resource: "Users/MB/Messages/M9" }] },
      }),
      ctx
    );
    expect(res.status).toBe(202);
    expect(ctx.extraOutputs.set).not.toHaveBeenCalled();
  });

  it("fails closed: drops everything when clientState is not configured", async () => {
    delete process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE;
    const ctx = fakeContext();
    const res = await notify(
      fakeRequest({
        body: {
          value: [
            { clientState: "anything", resource: "Users/MB/Messages/M9", resourceData: { id: "M9" } },
          ],
        },
      }),
      ctx
    );
    expect(res.status).toBe(202);
    expect(ctx.extraOutputs.set).not.toHaveBeenCalled();
  });

  it("returns 202 with nothing to enqueue when the body is missing", async () => {
    const ctx = fakeContext();
    const res = await notify(fakeRequest({}), ctx);
    expect(res.status).toBe(202);
    expect(ctx.extraOutputs.set).not.toHaveBeenCalled();
  });
});
