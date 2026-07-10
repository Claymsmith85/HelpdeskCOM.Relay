// Unit tests for the generic alert engine (alerts.ts): category routing, the once-daily blob
// throttle, recipient resolution, kill switches, and the send loop's failure modes.
//
// The storage REST boundary is mocked with axios-mock-adapter on an injected axios instance
// (opts.client), so no real Storage account or credential is needed — the same seam drain-lock.ts
// uses. Graph's sendMail is mocked at the module boundary. Routing is the REAL team-mapping table,
// so these tests also pin the engine-to-routing contract (env "Production"/"Development" resolve
// to the hardcoded team GUIDs).

jest.mock("@azure/identity", () => ({
  DefaultAzureCredential: jest.fn().mockImplementation(() => ({
    getToken: jest.fn().mockResolvedValue({ token: "fake-storage-token" }),
  })),
}));
jest.mock("./graph-mail", () => ({ sendMailViaGraph: jest.fn().mockResolvedValue(undefined) }));

import axios, { AxiosInstance } from "axios";
import MockAdapter from "axios-mock-adapter";
import { sendMailViaGraph } from "./graph-mail";
import { HelpdeskAgent } from "./helpdesk-client";
import { ALERT_TEAMS_BY_ENV } from "./team-mapping";
import {
  ALERT_FROM_MAILBOX,
  AlertOptions,
  alertBlobName,
  alertDateKey,
  alertEnabled,
  alertRecipients,
  claimDailyAlert,
  sendAlert,
} from "./alerts";

const LICENSING_PROD = ALERT_TEAMS_BY_ENV.Production.licensing!;
const IT_PROD = ALERT_TEAMS_BY_ENV.Production.it!;
const IT_DEV = ALERT_TEAMS_BY_ENV.Development.it!;
const CONTAINER = "/relay-state?restype=container";
const graph = {} as AxiosInstance;

function agent(email: string, teamIDs: string[]): HelpdeskAgent {
  return { ID: `id-${email}`, email, roles: ["normal"], teamIDs };
}

let client: AxiosInstance;
let mock: MockAdapter;
const OLD_ENV = process.env;

beforeEach(() => {
  // The loop guard (shouldSuppressRecipient -> shouldIgnoreSender -> hashDomain) requires both.
  process.env = {
    ...OLD_ENV,
    MAILBOX_ADDRESSES: "escape@corespecialty.com",
    RELAY_HASH_DOMAIN: "relay.corespecialty.com",
  };
  delete process.env.ALERT_ENABLED;
  delete process.env.ALERT_IT_ENABLED;
  delete process.env.ALERT_LICENSING_ENABLED;
  client = axios.create();
  mock = new MockAdapter(client);
  (sendMailViaGraph as jest.Mock).mockClear().mockResolvedValue(undefined);
});
afterEach(() => {
  mock.restore();
  process.env = OLD_ENV;
});

describe("alertDateKey", () => {
  it("keys on the Eastern business day, not UTC", () => {
    // 02:00 UTC on Jul 11 is still 22:00 ET on Jul 10 — the alert belongs to the 10th.
    expect(alertDateKey(new Date("2026-07-11T02:00:00Z"))).toBe("2026-07-10");
    expect(alertDateKey(new Date("2026-07-11T12:00:00Z"))).toBe("2026-07-11");
  });
});

describe("alertBlobName", () => {
  it("is per-environment, per-category, per-key, per-day, on a safe blob charset", () => {
    expect(alertBlobName("Production", "licensing", "seat-limit", "2026-07-10")).toBe(
      "alert-production-licensing-seat-limit-2026-07-10"
    );
    expect(alertBlobName(undefined, "it", "sync-failure-invite422", "2026-07-10")).toBe(
      "alert-unknown-it-sync-failure-invite422-2026-07-10"
    );
    expect(alertBlobName("Dev/Test", "it", "Weird Key!", "2026-07-10")).toBe(
      "alert-dev-test-it-weird-key--2026-07-10"
    );
  });
});

describe("alertEnabled (kill switches, read per-invocation)", () => {
  it("defaults ON for every category", () => {
    expect(alertEnabled("it")).toBe(true);
    expect(alertEnabled("licensing")).toBe(true);
  });

  it("ALERT_ENABLED=false silences every category", () => {
    process.env.ALERT_ENABLED = "false";
    expect(alertEnabled("it")).toBe(false);
    expect(alertEnabled("licensing")).toBe(false);
  });

  it("per-category flags silence only their own category", () => {
    process.env.ALERT_IT_ENABLED = "false";
    expect(alertEnabled("it")).toBe(false);
    expect(alertEnabled("licensing")).toBe(true);

    delete process.env.ALERT_IT_ENABLED;
    process.env.ALERT_LICENSING_ENABLED = "false";
    expect(alertEnabled("it")).toBe(true);
    expect(alertEnabled("licensing")).toBe(false);
  });
});

describe("claimDailyAlert", () => {
  it("claims the day on first PUT (create-if-absent)", async () => {
    mock.onPut(CONTAINER).reply(201);
    mock.onPut(/\/relay-state\/alert-/).reply(201);
    await expect(claimDailyAlert(client, "alert-production-licensing-x-2026-07-10", "{}")).resolves.toBe(true);
    const put = mock.history.put.find((p) => p.url?.includes("alert-"))!;
    expect(put.headers?.["If-None-Match"]).toBe("*");
  });

  it("tolerates an already-existing container", async () => {
    mock.onPut(CONTAINER).reply(409);
    mock.onPut(/\/relay-state\/alert-/).reply(201);
    await expect(claimDailyAlert(client, "alert-x", "{}")).resolves.toBe(true);
  });

  it.each([409, 412])("returns false when the blob already exists (%i)", async (status) => {
    mock.onPut(CONTAINER).reply(201);
    mock.onPut(/\/relay-state\/alert-/).reply(status);
    await expect(claimDailyAlert(client, "alert-x", "{}")).resolves.toBe(false);
  });

  it("throws on any other storage failure (fail-closed: no mail rather than hourly mail)", async () => {
    mock.onPut(CONTAINER).reply(201);
    mock.onPut(/\/relay-state\/alert-/).reply(403);
    await expect(claimDailyAlert(client, "alert-x", "{}")).rejects.toMatchObject({
      response: { status: 403 },
    });
  });
});

describe("alertRecipients", () => {
  it("selects the routed team's agents, dedupes, and skips our own drain mailboxes", () => {
    const agents = [
      agent("boss@corespecialty.com", [LICENSING_PROD]),
      agent("BOSS@corespecialty.com", [LICENSING_PROD, "other"]), // same person, different case
      agent("agent@corespecialty.com", ["other"]), // not on the routed team
      agent("escape@corespecialty.com", [LICENSING_PROD]), // a drain mailbox — mailing it would loop
    ];
    expect(alertRecipients(agents, LICENSING_PROD)).toEqual(["boss@corespecialty.com"]);
  });

  it("returns [] when nobody is on the team", () => {
    expect(alertRecipients([agent("a@x.com", ["other"])], LICENSING_PROD)).toEqual([]);
  });
});

describe("sendAlert", () => {
  const agents = [
    agent("boss@corespecialty.com", [LICENSING_PROD]),
    agent("vp@corespecialty.com", [LICENSING_PROD]),
    agent("dev@corespecialty.com", [IT_PROD]),
  ];

  function opts(over: Partial<AlertOptions> = {}): AlertOptions {
    return {
      category: "licensing",
      key: "seat-limit",
      subject: "subject line",
      body: "body content",
      graph,
      agents,
      environment: "Production",
      log: jest.fn(),
      client,
      now: () => new Date("2026-07-10T14:00:00Z"),
      ...over,
    };
  }

  function mockClaimOk() {
    mock.onPut(CONTAINER).reply(201);
    mock.onPut(/\/relay-state\/alert-/).reply(201);
  }

  it("routes by category: licensing mails ONLY the licensing team, from the alert mailbox", async () => {
    mockClaimOk();

    await expect(sendAlert(opts())).resolves.toBe("sent");

    expect(sendMailViaGraph).toHaveBeenCalledTimes(2);
    const calls = (sendMailViaGraph as jest.Mock).mock.calls.map(([a]) => a);
    expect(calls.map((c) => c.to).sort()).toEqual(["boss@corespecialty.com", "vp@corespecialty.com"]);
    expect(calls.every((c) => c.mailbox === ALERT_FROM_MAILBOX)).toBe(true);
    expect(ALERT_FROM_MAILBOX).toBe("escape@corespecialty.com");
    // The engine appends the environment/automation footer to the definition's body content.
    expect(calls[0].body).toContain("body content");
    expect(calls[0].body).toContain("Environment: Production");
    expect(calls[0].body).toContain("automated message");
    // Claimed under the (environment, category, key, ET day) blob.
    expect(
      mock.history.put.some((p) => p.url?.includes("alert-production-licensing-seat-limit-2026-07-10"))
    ).toBe(true);
  });

  it("routes by category: it mails ONLY the IT team", async () => {
    mockClaimOk();

    await expect(sendAlert(opts({ category: "it", key: "sync-failure-invite422" }))).resolves.toBe("sent");

    const calls = (sendMailViaGraph as jest.Mock).mock.calls.map(([a]) => a);
    expect(calls.map((c) => c.to)).toEqual(["dev@corespecialty.com"]);
    expect(
      mock.history.put.some((p) => p.url?.includes("alert-production-it-sync-failure-invite422-2026-07-10"))
    ).toBe(true);
  });

  it("sends IT alerts in Development too (routed to Development's IT team)", async () => {
    mockClaimOk();
    const devAgents = [agent("dev@corespecialty.com", [IT_DEV])];

    await expect(
      sendAlert(opts({ category: "it", agents: devAgents, environment: "Development" }))
    ).resolves.toBe("sent");
    expect(sendMailViaGraph).toHaveBeenCalledTimes(1);
    expect(mock.history.put.some((p) => p.url?.includes("alert-development-it-"))).toBe(true);
  });

  it("sends nothing on the second run of the same day (the blob claim is already held)", async () => {
    mock.onPut(CONTAINER).reply(201);
    mock.onPut(/\/relay-state\/alert-/).reply(409); // another invocation claimed it

    await expect(sendAlert(opts())).resolves.toBe("throttled");
    expect(sendMailViaGraph).not.toHaveBeenCalled();
  });

  it("throttles per KEY: a different key the same day claims its own blob", async () => {
    // The seat-limit blob exists; a different key's blob does not.
    mock.onPut(CONTAINER).reply(201);
    mock.onPut(/\/relay-state\/alert-production-licensing-seat-limit-/).reply(409);
    mock.onPut(/\/relay-state\/alert-production-licensing-other-/).reply(201);

    await expect(sendAlert(opts({ key: "seat-limit" }))).resolves.toBe("throttled");
    await expect(sendAlert(opts({ key: "other" }))).resolves.toBe("sent");
  });

  it("sends nothing when the environment maps no team for the category", async () => {
    await expect(sendAlert(opts({ environment: "Development" }))).resolves.toBe("not-configured");
    // Unset/unknown environments fall back to the Development row — licensing stays unmapped.
    await expect(sendAlert(opts({ environment: undefined }))).resolves.toBe("not-configured");
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(mock.history.put).toHaveLength(0); // never even touches storage
  });

  it("does not claim the day when the routed team has no mailable agents", async () => {
    const only = [agent("escape@corespecialty.com", [LICENSING_PROD])]; // suppressed as a drain mailbox
    await expect(sendAlert(opts({ agents: only }))).resolves.toBe("no-recipients");
    expect(mock.history.put).toHaveLength(0);
  });

  it("still mails the rest of the team when one recipient's send fails", async () => {
    mockClaimOk();
    (sendMailViaGraph as jest.Mock)
      .mockRejectedValueOnce(new Error("bad mailbox"))
      .mockResolvedValueOnce(undefined);

    await expect(sendAlert(opts())).resolves.toBe("sent");
    expect(sendMailViaGraph).toHaveBeenCalledTimes(2);
    expect(mock.history.delete).toHaveLength(0); // the day stays claimed — someone got it
  });

  it("releases the day's claim when EVERY send fails, so the next run retries", async () => {
    mockClaimOk();
    mock.onDelete(/\/relay-state\/alert-/).reply(202);
    (sendMailViaGraph as jest.Mock).mockRejectedValue(new Error("graph down"));

    await expect(sendAlert(opts())).resolves.toBe("send-failed");
    expect(mock.history.delete).toHaveLength(1);
    expect(mock.history.delete[0].url).toContain("alert-production-licensing-seat-limit-2026-07-10");
  });

  it("propagates a storage failure (fail-closed) rather than mailing unthrottled", async () => {
    mock.onPut(CONTAINER).reply(201);
    mock.onPut(/\/relay-state\/alert-/).reply(403);

    await expect(sendAlert(opts())).rejects.toMatchObject({ response: { status: 403 } });
    expect(sendMailViaGraph).not.toHaveBeenCalled();
  });

  it("honours the kill switches: master kills all, per-category kills only its own", async () => {
    mockClaimOk();

    process.env.ALERT_ENABLED = "false";
    await expect(sendAlert(opts())).resolves.toBe("disabled");
    await expect(sendAlert(opts({ category: "it" }))).resolves.toBe("disabled");
    expect(mock.history.put).toHaveLength(0);

    delete process.env.ALERT_ENABLED;
    process.env.ALERT_IT_ENABLED = "false";
    await expect(sendAlert(opts({ category: "it" }))).resolves.toBe("disabled");
    await expect(sendAlert(opts())).resolves.toBe("sent"); // licensing unaffected
  });
});
