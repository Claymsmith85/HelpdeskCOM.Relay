// Tests for the poison-queue monitor (mail-poison.ts): a dead-lettered drain item must be logged
// at ERROR severity (alertable) and the handler must never throw. Importing registers a queue
// trigger, so @azure/functions is mocked to a no-op registry.

jest.mock("@azure/functions", () => ({
  app: { http: jest.fn(), setup: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() },
}));

import { mailPoison } from "./mail-poison";

function fakeContext() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    functionName: "mail-poison",
    invocationId: "test-inv",
  } as any;
}

describe("mailPoison", () => {
  it("logs the poisoned item at error severity without throwing", async () => {
    const ctx = fakeContext();

    await expect(mailPoison({ mailbox: "a@x.com", messageId: "M1" }, ctx)).resolves.toBeUndefined();

    expect(ctx.error).toHaveBeenCalledTimes(1);
    const [line, payload] = (ctx.error as jest.Mock).mock.calls[0];
    expect(String(line)).toMatch(/POISONED/);
    expect(payload.queueItem).toContain("a@x.com");
  });
});
