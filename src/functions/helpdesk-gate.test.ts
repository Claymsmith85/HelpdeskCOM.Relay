// Tests for the global Helpdesk throttle gate (helpdesk-gate.ts).
//
// What these lock in:
//   - a 429 opens ONE shared cooldown that every later request waits on, instead of each caller
//     spending its own request to rediscover the throttle
//   - Retry-After is honored, absence falls back to a default, and both are capped
//   - a cooldown only ever EXTENDS (a shorter concurrent penalty can't shorten a longer one)
//   - the request interceptor waits, and dispatches anyway once its budget is spent
//   - waitOrDefer distinguishes "short, sit it out" from "long, put the work back"
//
// Clock and sleep are injected (the http-retry.ts / drain-lock.ts convention) so nothing waits on a
// real timer.

import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import {
  attachHelpdeskGateInterceptor,
  createHelpdeskGate,
  gateExceedsDeferBudget,
  helpdeskGate,
  waitOrDefer,
} from "./helpdesk-gate";
import { attachRateLimitInterceptor, createRateLimiter } from "./rate-limit";

/** A controllable clock plus a sleep that records requested delays and advances that clock. */
function harness(start = 1_000_000) {
  let clock = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => clock,
    advance: (ms: number) => void (clock += ms),
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
  };
}

const COOLDOWN = { defaultMs: 10_000, maxMs: 300_000 };

describe("createHelpdeskGate", () => {
  it("starts clear", () => {
    const h = harness();
    const gate = createHelpdeskGate({ now: h.now, sleep: h.sleep });

    expect(gate.remainingMs()).toBe(0);
    expect(gate.isDirty()).toBe(false);
  });

  it("honors Retry-After and counts down as time passes", () => {
    const h = harness();
    const gate = createHelpdeskGate({ now: h.now, sleep: h.sleep });

    gate.penalize(45_000, COOLDOWN);

    expect(gate.remainingMs()).toBe(45_000);
    h.advance(20_000);
    expect(gate.remainingMs()).toBe(25_000);
    h.advance(30_000);
    expect(gate.remainingMs()).toBe(0);
  });

  it("falls back to the default cooldown when the 429 carries no Retry-After", () => {
    const h = harness();
    const gate = createHelpdeskGate({ now: h.now, sleep: h.sleep });

    gate.penalize(null, COOLDOWN);

    expect(gate.remainingMs()).toBe(COOLDOWN.defaultMs);
  });

  it("treats Retry-After: 0 as a real answer rather than a missing header", () => {
    const h = harness();
    const gate = createHelpdeskGate({ now: h.now, sleep: h.sleep });

    gate.penalize(0, COOLDOWN);

    expect(gate.remainingMs()).toBe(0);
  });

  it("caps a hostile or bogus Retry-After", () => {
    const h = harness();
    const gate = createHelpdeskGate({ now: h.now, sleep: h.sleep });

    gate.penalize(9_999_999, COOLDOWN);

    expect(gate.remainingMs()).toBe(COOLDOWN.maxMs);
  });

  it("only ever EXTENDS — a shorter concurrent penalty cannot shorten a longer one", () => {
    const h = harness();
    const gate = createHelpdeskGate({ now: h.now, sleep: h.sleep });

    gate.penalize(60_000, COOLDOWN);
    gate.penalize(5_000, COOLDOWN); // a second in-flight request's 429 lands with a smaller value

    expect(gate.remainingMs()).toBe(60_000);
  });

  it("adopt takes a longer external deadline and ignores a shorter or stale one", () => {
    const h = harness();
    const gate = createHelpdeskGate({ now: h.now, sleep: h.sleep });
    gate.penalize(20_000, COOLDOWN);

    gate.adopt(h.now() + 5_000); // another instance's shorter pause
    expect(gate.remainingMs()).toBe(20_000);

    gate.adopt(h.now() + 90_000); // another instance is throttled harder
    expect(gate.remainingMs()).toBe(90_000);
  });

  it("waitUntilClear sleeps exactly the remaining time and reports clear", async () => {
    const h = harness();
    const gate = createHelpdeskGate({ now: h.now, sleep: h.sleep });
    gate.penalize(12_000, COOLDOWN);

    const still = await gate.waitUntilClear(30_000);

    expect(h.slept).toEqual([12_000]);
    expect(still).toBe(0);
  });

  it("waitUntilClear stops at its budget and reports the remainder", async () => {
    const h = harness();
    const gate = createHelpdeskGate({ now: h.now, sleep: h.sleep });
    gate.penalize(50_000, COOLDOWN);

    const still = await gate.waitUntilClear(5_000);

    expect(h.slept).toEqual([5_000]);
    expect(still).toBe(45_000);
  });

  it("waitUntilClear does not sleep when the gate is already clear", async () => {
    const h = harness();
    const gate = createHelpdeskGate({ now: h.now, sleep: h.sleep });

    expect(await gate.waitUntilClear(30_000)).toBe(0);
    expect(h.slept).toEqual([]);
  });

  it("tracks a dirty flag so a cooldown is published once", () => {
    const h = harness();
    const gate = createHelpdeskGate({ now: h.now, sleep: h.sleep });

    expect(gate.isDirty()).toBe(false);
    gate.penalize(10_000, COOLDOWN);
    expect(gate.isDirty()).toBe(true);

    gate.markPublished();
    expect(gate.isDirty()).toBe(false);

    // A penalty that does not extend the deadline is not worth re-publishing.
    gate.penalize(1_000, COOLDOWN);
    expect(gate.isDirty()).toBe(false);
  });
});

describe("attachHelpdeskGateInterceptor", () => {
  function wire(gate = createHelpdeskGate(), maxWaitMs = 30_000) {
    const client = axios.create();
    const mock = new MockAdapter(client);
    const waited: Array<{ waitedForMs: number; stillGatedMs: number }> = [];
    const penalties: Array<{ cooldownMs: number; retryAfterMs: number | null }> = [];
    attachHelpdeskGateInterceptor(client, gate, {
      maxWaitMs,
      cooldown: COOLDOWN,
      onWaited: (waitedForMs, stillGatedMs) => void waited.push({ waitedForMs, stillGatedMs }),
      onPenalized: (cooldownMs, retryAfterMs) => void penalties.push({ cooldownMs, retryAfterMs }),
    });
    return { client, mock, waited, penalties, gate };
  }

  it("opens a cooldown from a 429's Retry-After", async () => {
    const h = harness();
    const w = wire(createHelpdeskGate({ now: h.now, sleep: h.sleep }));
    w.mock.onGet("/tickets").reply(429, "", { "retry-after": "30" });

    await w.client.get("/tickets").catch(() => undefined);

    expect(w.gate.remainingMs()).toBe(30_000);
    expect(w.penalties).toEqual([{ cooldownMs: 30_000, retryAfterMs: 30_000 }]);
  });

  it("makes a LATER request wait on the cooldown a FIRST request opened", async () => {
    const h = harness();
    const gate = createHelpdeskGate({ now: h.now, sleep: h.sleep });
    const w = wire(gate);
    w.mock.onGet("/first").reply(429, "", { "retry-after": "20" });
    w.mock.onGet("/second").reply(200, { ok: true });

    await w.client.get("/first").catch(() => undefined);
    await w.client.get("/second");

    // The second call did not spend a request to rediscover the throttle — it waited it out.
    expect(h.slept).toEqual([20_000]);
    expect(w.waited).toEqual([{ waitedForMs: 20_000, stillGatedMs: 0 }]);
    expect(gate.remainingMs()).toBe(0);
  });

  it("dispatches anyway once its wait budget is spent", async () => {
    const h = harness();
    const gate = createHelpdeskGate({ now: h.now, sleep: h.sleep });
    gate.penalize(60_000, COOLDOWN);
    const w = wire(gate, 5_000); // the webhook's short budget
    w.mock.onGet("/tickets").reply(200, { ok: true });

    const res = await w.client.get("/tickets");

    expect(res.status).toBe(200);
    expect(h.slept).toEqual([5_000]);
    expect(w.waited).toEqual([{ waitedForMs: 5_000, stillGatedMs: 55_000 }]);
  });

  it("does not open a cooldown for non-429 failures", async () => {
    const h = harness();
    const w = wire(createHelpdeskGate({ now: h.now, sleep: h.sleep }));
    w.mock.onGet("/a").reply(500);
    w.mock.onGet("/b").reply(422);

    await w.client.get("/a").catch(() => undefined);
    await w.client.get("/b").catch(() => undefined);

    expect(w.gate.remainingMs()).toBe(0);
    expect(w.penalties).toEqual([]);
  });
});

// The release behavior when a cooldown expires. This is the reason the gate interceptor must run
// BEFORE the rate limiter's: if a waiter reserved its dispatch slot first and then slept out the
// cooldown holding it, every waiter's slot would already be in the past when the gate opened and
// the whole backlog would fire at once — a stampede at the exact moment Helpdesk is least able to
// take one. Waiting first and reserving after means the limiter re-paces the released queue.
//
// Registration order below mirrors createHelpdeskClient exactly (rate limit, then gate), because
// axios runs request interceptors in REVERSE registration order.
describe("cooldown expiry does not stampede", () => {
  it("re-paces released requests through the rate limiter instead of releasing them together", async () => {
    const events: string[] = [];
    let clock = 1_000_000;
    const now = () => clock;
    const advance = (ms: number) => void (clock += ms);

    const gate = createHelpdeskGate({
      now,
      sleep: async (ms) => {
        events.push(`gate-wait:${ms}`);
        advance(ms);
      },
    });
    const limiter = createRateLimiter({
      now,
      sleep: async (ms) => {
        events.push(`limiter-wait:${ms}`);
        advance(ms);
      },
    });

    const client = axios.create();
    const mock = new MockAdapter(client);
    attachRateLimitInterceptor(client, limiter, 200); // 5 rps
    attachHelpdeskGateInterceptor(client, gate, { maxWaitMs: 60_000, cooldown: COOLDOWN });
    mock.onGet("/tickets").reply(200, []);

    gate.penalize(20_000, COOLDOWN);

    // Four requests released by the same cooldown, issued back to back.
    for (let i = 0; i < 4; i++) await client.get("/tickets");

    // The gate is waited BEFORE any slot is reserved (the first entry is a gate wait, not a
    // limiter wait), and only the first request pays it — the cooldown is gone for the rest.
    expect(events[0]).toBe("gate-wait:20000");
    expect(events.filter((e) => e.startsWith("gate-wait")).length).toBe(1);

    // The released requests are then spaced by the limiter rather than firing together.
    expect(events.filter((e) => e.startsWith("limiter-wait"))).toEqual([
      "limiter-wait:200",
      "limiter-wait:200",
      "limiter-wait:200",
    ]);
    mock.restore();
  });

  it("banks no burst credit while the gate is closed", async () => {
    // The limiter reserves from max(now, nextSlot), so time spent parked on the gate does not
    // accumulate slots that would all come due at once when it opens.
    let clock = 1_000_000;
    const slept: number[] = [];
    const limiter = createRateLimiter({
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    await limiter.acquire(200); // first dispatch is free
    clock += 60_000; // a long cooldown elapses with no traffic

    await limiter.acquire(200);
    await limiter.acquire(200);

    // The first post-cooldown request goes straight out; only the one behind it is paced.
    expect(slept).toEqual([200]);
  });
});

describe("waitOrDefer / gateExceedsDeferBudget", () => {
  afterEach(() => {
    helpdeskGate.reset();
    delete process.env.HELPDESK_GATE_ENABLED;
    delete process.env.HELPDESK_GATE_DEFER_ABOVE_MS;
  });

  it("returns 0 when there is no cooldown", async () => {
    expect(await waitOrDefer()).toBe(0);
    expect(gateExceedsDeferBudget()).toBe(false);
  });

  it("reports a long cooldown so the caller defers", async () => {
    process.env.HELPDESK_GATE_DEFER_ABOVE_MS = "30000";
    helpdeskGate.penalize(120_000, COOLDOWN);

    expect(gateExceedsDeferBudget()).toBe(true);
  });

  it("is inert when the gate is switched off", async () => {
    process.env.HELPDESK_GATE_ENABLED = "false";
    helpdeskGate.penalize(120_000, COOLDOWN);

    expect(await waitOrDefer()).toBe(0);
    expect(gateExceedsDeferBudget()).toBe(false);
  });
});
