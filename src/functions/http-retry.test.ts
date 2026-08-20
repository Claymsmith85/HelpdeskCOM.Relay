// Tests for the shared axios retry policy (http-retry.ts). The retry SAFETY rules are the point:
//   - 429/503 are safe to retry for any method (server rejected before processing)
//   - ambiguous 5xx / transport errors are retried only for idempotent reads (GET/HEAD)
// Sleep is injected so retries don't wait on a real timer.

import axios, { AxiosError, AxiosInstance } from "axios";
import MockAdapter from "axios-mock-adapter";
import { attachRetryInterceptor, isRetryable, parseRetryAfter } from "./http-retry";
import { formatAxiosError } from "./logging";

// No-op sleep that records the requested delays so backoff/Retry-After can be asserted.
function recordingSleep() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

function client(opts?: Parameters<typeof attachRetryInterceptor>[1]): {
  instance: AxiosInstance;
  mock: MockAdapter;
} {
  const instance = axios.create();
  const mock = new MockAdapter(instance);
  attachRetryInterceptor(instance, { baseDelayMs: 1, sleep: async () => {}, ...opts });
  return { instance, mock };
}

describe("parseRetryAfter", () => {
  it("parses delta-seconds into milliseconds", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0")).toBe(0);
  });
  it("parses an array header (takes the first value)", () => {
    expect(parseRetryAfter(["3"])).toBe(3000);
  });
  it("parses an HTTP date into a future delay", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfter(future)!;
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(5000);
  });
  it("returns null for missing/blank/garbage", () => {
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("isRetryable (safety rules)", () => {
  const err = (over: Partial<AxiosError>): AxiosError => over as AxiosError;

  it("retries 429/503 for ANY method (rejected before processing)", () => {
    expect(isRetryable(err({ config: { method: "post" } as any, response: { status: 429 } as any }))).toBe(true);
    expect(isRetryable(err({ config: { method: "patch" } as any, response: { status: 503 } as any }))).toBe(true);
  });

  it("does NOT retry ambiguous 5xx for non-idempotent methods", () => {
    expect(isRetryable(err({ config: { method: "post" } as any, response: { status: 500 } as any }))).toBe(false);
    expect(isRetryable(err({ config: { method: "patch" } as any, response: { status: 504 } as any }))).toBe(false);
  });

  it("retries ambiguous 5xx for idempotent reads", () => {
    expect(isRetryable(err({ config: { method: "get" } as any, response: { status: 500 } as any }))).toBe(true);
    expect(isRetryable(err({ config: { method: "get" } as any, response: { status: 502 } as any }))).toBe(true);
  });

  it("does NOT retry 4xx (other than 429)", () => {
    expect(isRetryable(err({ config: { method: "get" } as any, response: { status: 404 } as any }))).toBe(false);
    expect(isRetryable(err({ config: { method: "get" } as any, response: { status: 400 } as any }))).toBe(false);
  });

  it("retries a dispatched transport error only for idempotent reads", () => {
    expect(isRetryable(err({ config: { method: "get" } as any, request: {}, code: "ECONNRESET" }))).toBe(true);
    expect(isRetryable(err({ config: { method: "post" } as any, request: {}, code: "ECONNRESET" }))).toBe(false);
  });
});

describe("attachRetryInterceptor (end to end)", () => {
  it("retries a 429 then succeeds", async () => {
    const { instance, mock } = client();
    mock.onGet("/x").replyOnce(429);
    mock.onGet("/x").replyOnce(200, { ok: true });

    const res = await instance.get("/x");
    expect(res.data).toEqual({ ok: true });
    expect(mock.history.get).toHaveLength(2);
  });

  it("retries a 429 on a non-idempotent POST (safe — server rejected it)", async () => {
    const { instance, mock } = client();
    mock.onPost("/x").replyOnce(503);
    mock.onPost("/x").replyOnce(201, { id: 1 });

    const res = await instance.post("/x", {});
    expect(res.data).toEqual({ id: 1 });
    expect(mock.history.post).toHaveLength(2);
  });

  it("does NOT retry a 500 on a POST (could duplicate the side effect)", async () => {
    const { instance, mock } = client();
    mock.onPost("/x").reply(500);

    await expect(instance.post("/x", {})).rejects.toBeTruthy();
    expect(mock.history.post).toHaveLength(1);
  });

  it("does NOT retry a 404 and labels the failing API", async () => {
    const { instance, mock } = client({ apiName: "Microsoft Graph" });
    mock.onGet("/x").reply(404);

    const error = await instance.get("/x").catch((e) => e);
    expect(formatAxiosError(error)).toMatchObject({
      api: "Microsoft Graph",
      retries: 0,
      status: 404,
      message: expect.stringContaining("[Microsoft Graph API]"),
    });
    expect(mock.history.get).toHaveLength(1);
  });

  it("gives up after maxRetries and reports the API plus retry count", async () => {
    const { instance, mock } = client({ apiName: "Helpdesk", maxRetries: 3 });
    mock.onGet("/x").reply(429);

    const error = await instance.get("/x").catch((e) => e);
    expect(formatAxiosError(error)).toMatchObject({
      api: "Helpdesk",
      retries: 3,
      status: 429,
      message: expect.stringContaining("[Helpdesk API]"),
    });
    expect(mock.history.get).toHaveLength(4); // initial + 3 retries
  });

  it("honors Retry-After over the backoff schedule", async () => {
    const { delays, sleep } = recordingSleep();
    const { instance, mock } = client({ sleep });
    mock.onGet("/x").replyOnce(429, undefined, { "retry-after": "2" });
    mock.onGet("/x").replyOnce(200, {});

    await instance.get("/x");
    expect(delays).toEqual([2000]);
  });

  it("uses a configured max delay to lift the Retry-After clamp", async () => {
    const { delays, sleep } = recordingSleep();
    const { instance, mock } = client({ maxDelayMs: 60_000, sleep });
    mock.onGet("/x").replyOnce(429, undefined, { "retry-after": "45" });
    mock.onGet("/x").replyOnce(200, {});

    await instance.get("/x");
    expect(delays).toEqual([45_000]);
  });

  // maxDelayMs must bound the delay actually slept, jitter included. It previously capped only the
  // exponential term and then added up to baseDelayMs on top, so the real ceiling was
  // maxDelayMs + baseDelayMs and grew with baseDelayMs — which meant a caller could not bound (or a
  // test pin) the ladder by lowering maxDelayMs.
  it("never sleeps longer than maxDelayMs, jitter included", async () => {
    const { delays, sleep } = recordingSleep();
    const { instance, mock } = client({
      baseDelayMs: 5_000,
      maxDelayMs: 1_000,
      maxRetries: 4,
      sleep,
    });
    mock.onGet("/x").reply(503);

    await instance.get("/x").catch(() => undefined);

    expect(delays).toHaveLength(4);
    for (const d of delays) expect(d).toBeLessThanOrEqual(1_000);
  });
});
