// Tests for the Helpdesk client's by-shortID ticket lookup (helpdesk-client.ts). The HTTP boundary
// is mocked with axios-mock-adapter on a plain axios instance (the function takes the client as an
// argument, so createHelpdeskClient's env requirements never come into play).

import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { createHelpdeskClient, findTicketByShortId } from "./helpdesk-client";
import { formatAxiosError } from "./logging";
import { helpdeskGate } from "./helpdesk-gate";

describe("createHelpdeskClient wiring", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    // The gate is a process-wide singleton, so a cooldown opened here would leak into later tests.
    helpdeskGate.reset();
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
    // Request side: call-log timing, rate limit, throttle gate.
    // Response side: call-log, gate penalty, retry.
    expect((shared.interceptors.request as any).handlers).toHaveLength(3);
    expect((shared.interceptors.response as any).handlers).toHaveLength(3);

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

// One Application Insights entry per REQUEST ATTEMPT, at a severity that keeps
// `severityLevel >= 3` a real failure signal: a 429 that is about to be retried is a warning, only
// a terminal failure is an error. Request bodies are summarized by shape, never logged verbatim.
describe("createHelpdeskClient per-call telemetry", () => {
  function recordingLogger() {
    const info: any[] = [];
    const warn: any[] = [];
    const error: any[] = [];
    return {
      info,
      warn,
      error,
      logger: {
        step: (name: string, data?: any) => void info.push({ name, data }),
        stepWarn: (name: string, data?: any) => void warn.push({ name, data }),
        stepError: (name: string, err: any, data?: any) => void error.push({ name, err, data }),
      },
    };
  }

  function wire(rec: ReturnType<typeof recordingLogger>) {
    const shared = axios.create();
    const mock = new MockAdapter(shared);
    jest.spyOn(axios, "create").mockReturnValue(shared);
    createHelpdeskClient(rec.logger);
    return { shared, mock };
  }

  beforeEach(() => {
    process.env.HELPDESK_PAT = "pat-token";
    process.env.HELPDESK_RATE_LIMIT_RPS = "100000"; // no pacing sleeps in tests
    process.env.HELPDESK_RETRY_MAX_DELAY_MS = "1";
    // These cases are about the call-log entries only; the gate emits its own and is covered by
    // helpdesk-gate.test.ts.
    process.env.HELPDESK_GATE_ENABLED = "false";
  });

  afterEach(() => {
    jest.restoreAllMocks();
    helpdeskGate.reset();
    delete process.env.HELPDESK_PAT;
    delete process.env.HELPDESK_RATE_LIMIT_RPS;
    delete process.env.HELPDESK_RETRY_MAX_RETRIES;
    delete process.env.HELPDESK_RETRY_MAX_DELAY_MS;
    delete process.env.HELPDESK_GATE_ENABLED;
  });

  it("logs one info entry for a clean call", async () => {
    const rec = recordingLogger();
    const { shared, mock } = wire(rec);
    mock.onGet("/tickets/T1").reply(200, { ID: "T1" });

    await shared.get("/tickets/T1");

    expect(rec.warn).toHaveLength(0);
    expect(rec.error).toHaveLength(0);
    expect(rec.info).toHaveLength(1);
    expect(rec.info[0].name).toBe("Helpdesk API");
    expect(rec.info[0].data).toMatchObject({
      method: "GET",
      path: "/tickets/T1",
      status: 200,
      retries: 0,
    });
    expect(typeof rec.info[0].data.ms).toBe("number");
    mock.restore();
  });

  it("logs a warning per retried 429 and a warning on the eventual success, never an error", async () => {
    const rec = recordingLogger();
    const { shared, mock } = wire(rec);
    // Retry-After: 0 is honored verbatim by http-retry, which skips the randomized backoff — the
    // jitter term is `random() * baseDelayMs` and is NOT clamped by maxDelayMs, so without this the
    // test would really sleep up to baseDelayMs (5s) per attempt.
    mock.onGet("/tickets").replyOnce(429, "", { "retry-after": "0" });
    mock.onGet("/tickets").replyOnce(429, "", { "retry-after": "0" });
    mock.onGet("/tickets").reply(200, []);

    await shared.get("/tickets");

    // Two throttled attempts, then the success — the success carries the retry count.
    expect(rec.error).toHaveLength(0);
    expect(rec.warn).toHaveLength(3);
    expect(rec.warn[0]).toMatchObject({
      name: "Helpdesk API retryable failure",
      data: { status: 429, retries: 0 },
    });
    expect(rec.warn[1]).toMatchObject({
      name: "Helpdesk API retryable failure",
      data: { status: 429, retries: 1 },
    });
    expect(rec.warn[2]).toMatchObject({
      name: "Helpdesk API ok after retries",
      data: { status: 200, retries: 2 },
    });
    expect(rec.info).toHaveLength(0);
    mock.restore();
  });

  it("logs an error for a terminal 4xx and never leaks request-body values", async () => {
    const rec = recordingLogger();
    const { shared, mock } = wire(rec);
    mock.onPost("/tickets").reply(422, { error: "bad requester" });

    await shared
      .post("/tickets", {
        subject: "Need help",
        message: { text: "SENSITIVE-CUSTOMER-BODY" },
        requester: { email: "john@example.com" },
      })
      .catch(() => undefined);

    // A POST 422 is not retryable, so it is terminal on the first attempt.
    expect(rec.warn).toHaveLength(0);
    expect(rec.error).toHaveLength(1);
    expect(rec.error[0].name).toBe("Helpdesk API FAILED");
    expect(rec.error[0].data).toMatchObject({ method: "POST", path: "/tickets", status: 422 });
    // Shape only: field NAMES survive, values do not.
    expect(rec.error[0].data.requestBody.fields).toEqual(["subject", "message", "requester"]);
    const serialized = JSON.stringify(rec.error[0].data);
    expect(serialized).not.toContain("SENSITIVE-CUSTOMER-BODY");
    expect(serialized).not.toContain("john@example.com");
    mock.restore();
  });

  it("logs an error once retries are exhausted", async () => {
    process.env.HELPDESK_RETRY_MAX_RETRIES = "1";
    const rec = recordingLogger();
    const { shared, mock } = wire(rec);
    mock.onGet("/tickets").reply(429, "", { "retry-after": "0" });

    await shared.get("/tickets").catch(() => undefined);

    expect(rec.warn).toHaveLength(1); // attempt 0: still retryable
    expect(rec.error).toHaveLength(1); // attempt 1: budget spent -> terminal
    expect(rec.error[0]).toMatchObject({
      name: "Helpdesk API FAILED",
      data: { status: 429, retries: 1 },
    });
    mock.restore();
  });

  it("is silent when no logger is supplied", async () => {
    const shared = axios.create();
    const mock = new MockAdapter(shared);
    jest.spyOn(axios, "create").mockReturnValue(shared);
    createHelpdeskClient();
    mock.onGet("/tickets/T1").reply(200, { ID: "T1" });

    await expect(shared.get("/tickets/T1")).resolves.toMatchObject({ data: { ID: "T1" } });
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
