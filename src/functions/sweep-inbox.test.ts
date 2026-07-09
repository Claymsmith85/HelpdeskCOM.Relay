// Tests for the safety-net sweep (sweep-inbox.ts). It enqueues one mailbox-only drain item per
// configured mailbox; the items must be the same shape process-mail's normalizeQueueItem accepts.
// Importing the module registers app.timer, so @azure/functions is mocked to a no-op registry.

jest.mock("@azure/functions", () => ({
  app: { http: jest.fn(), setup: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() },
  output: { storageQueue: jest.fn(() => ({ name: "sweep-out" })) },
}));

import { sweepInbox } from "./sweep-inbox";
import { normalizeQueueItem } from "./process-mail";

function fakeContext() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    functionName: "sweep-inbox",
    invocationId: "test-inv",
    extraOutputs: { set: jest.fn() },
  } as any;
}

afterEach(() => {
  delete process.env.MAILBOX_ADDRESSES;
});

describe("sweepInbox", () => {
  it("enqueues one mailbox-only drain item per configured mailbox", async () => {
    process.env.MAILBOX_ADDRESSES = "a@x.com, b@x.com ,c@x.com";
    const ctx = fakeContext();

    await sweepInbox({} as any, ctx);

    expect(ctx.extraOutputs.set).toHaveBeenCalledTimes(1);
    const [, items] = (ctx.extraOutputs.set as jest.Mock).mock.calls[0];
    expect(items.map((s: string) => JSON.parse(s))).toEqual([
      { mailbox: "a@x.com" },
      { mailbox: "b@x.com" },
      { mailbox: "c@x.com" },
    ]);
    // The enqueued shape must be exactly what the worker accepts as a "drain this mailbox" item.
    expect(normalizeQueueItem(items[0])).toEqual({ mailbox: "a@x.com" });
  });

  it("enqueues nothing when MAILBOX_ADDRESSES is empty", async () => {
    delete process.env.MAILBOX_ADDRESSES;
    const ctx = fakeContext();

    await sweepInbox({} as any, ctx);

    expect(ctx.extraOutputs.set).not.toHaveBeenCalled();
  });
});
