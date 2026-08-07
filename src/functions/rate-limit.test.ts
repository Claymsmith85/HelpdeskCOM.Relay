// Tests use an injected clock and recording sleep so limiter timing is deterministic and instant.

import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { attachRetryInterceptor } from "./http-retry";
import { attachRateLimitInterceptor, createRateLimiter } from "./rate-limit";

function recordingSleep() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

describe("createRateLimiter", () => {
  it("dispatches the first request immediately", async () => {
    const { delays, sleep } = recordingSleep();
    const limiter = createRateLimiter({ sleep, now: () => 1_000 });

    await limiter.acquire(200);

    expect(delays).toEqual([]);
  });

  it("spaces a burst into fixed-interval slots", async () => {
    const { delays, sleep } = recordingSleep();
    const limiter = createRateLimiter({ sleep, now: () => 1_000 });

    await limiter.acquire(200);
    await limiter.acquire(200);
    await limiter.acquire(200);
    await limiter.acquire(200);

    expect(delays).toEqual([200, 400, 600]);
  });

  it("does not bank idle time as burst credit", async () => {
    const { delays, sleep } = recordingSleep();
    let now = 1_000;
    const limiter = createRateLimiter({ sleep, now: () => now });

    await limiter.acquire(200);
    now = 2_000;
    await limiter.acquire(200);
    await limiter.acquire(200);

    expect(delays).toEqual([200]);
  });

  it("synchronously reserves distinct slots for concurrent callers", async () => {
    const { delays, sleep } = recordingSleep();
    const limiter = createRateLimiter({ sleep, now: () => 1_000 });

    await Promise.all([
      limiter.acquire(200),
      limiter.acquire(200),
      limiter.acquire(200),
    ]);

    expect(delays).toEqual([200, 400]);
  });

  it("is disabled when the interval is zero", async () => {
    const { delays, sleep } = recordingSleep();
    const limiter = createRateLimiter({ sleep, now: () => 1_000 });

    await limiter.acquire(0);

    expect(delays).toEqual([]);
  });
});

describe("attachRateLimitInterceptor", () => {
  it("paces axios requests", async () => {
    const { delays, sleep } = recordingSleep();
    const limiter = createRateLimiter({ sleep, now: () => 1_000 });
    const client = axios.create();
    const mock = new MockAdapter(client);
    attachRateLimitInterceptor(client, limiter, 200);
    mock.onGet("/x").reply(200, { ok: true });

    await client.get("/x");
    await client.get("/x");

    expect(delays).toEqual([200]);
    expect(mock.history.get).toHaveLength(2);
  });

  it("paces a retry when it re-enters the request interceptor", async () => {
    const { delays, sleep } = recordingSleep();
    const limiter = createRateLimiter({ sleep, now: () => 1_000 });
    const client = axios.create();
    const mock = new MockAdapter(client);
    attachRateLimitInterceptor(client, limiter, 200);
    attachRetryInterceptor(client, { sleep: async () => {} });
    mock.onGet("/x").replyOnce(429);
    mock.onGet("/x").replyOnce(200, { ok: true });

    await client.get("/x");

    expect(delays).toEqual([200]);
    expect(mock.history.get).toHaveLength(2);
  });
});
