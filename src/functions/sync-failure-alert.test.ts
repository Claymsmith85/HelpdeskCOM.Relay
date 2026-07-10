// Unit tests for the sync-failure (IT) alert definition (sync-failure-alert.ts). The engine has
// its own suite (alerts.test.ts); here we pin the error rendering, the signature-based throttle
// key, the mail content, and the definition-to-engine wiring by driving sendSyncFailureAlert
// through the REAL engine with an injected storage client.

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
  SyncFailure,
  describeError,
  sendSyncFailureAlert,
  syncFailureBody,
  syncFailureKey,
  syncFailureSubject,
} from "./sync-failure-alert";

const IT_PROD = ALERT_TEAMS_BY_ENV.Production.it!;
const IT_DEV = ALERT_TEAMS_BY_ENV.Development.it!;
const graph = {} as AxiosInstance;

/** The exact 422 body Helpdesk returned in production (July 2026) for the `status` key. */
const VALIDATION_422 = {
  error: {
    type: "validation",
    message: "Validation error",
    details: { errors: [{ field: "status", message: '"status" is not allowed' }] },
  },
};

function axiosErr(status: number, data: unknown): any {
  return { isAxiosError: true, response: { status, data } };
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
  client = axios.create();
  mock = new MockAdapter(client);
  (sendMailViaGraph as jest.Mock).mockClear().mockResolvedValue(undefined);
});
afterEach(() => {
  mock.restore();
  process.env = OLD_ENV;
});

describe("describeError", () => {
  it("renders a Helpdesk-style error body as status + type + message + details", () => {
    expect(describeError(axiosErr(422, VALIDATION_422))).toBe(
      'HTTP 422 validation: Validation error ({"errors":[{"field":"status","message":"\\"status\\" is not allowed"}]})'
    );
  });

  it("parses a JSON body delivered as a string (non-JSON content-type)", () => {
    expect(describeError(axiosErr(422, JSON.stringify(VALIDATION_422)))).toContain(
      "HTTP 422 validation: Validation error"
    );
  });

  it("excerpts a non-JSON body (e.g. an HTML error page)", () => {
    expect(describeError(axiosErr(502, "<html>Bad Gateway</html>"))).toBe(
      "HTTP 502: <html>Bad Gateway</html>"
    );
  });

  it("falls back to the plain message for a non-HTTP error, and caps the length", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError(axiosErr(500, undefined))).toBe("HTTP 500");
    const long = describeError(new Error("x".repeat(500)));
    expect(long).toHaveLength(301); // 300 + the ellipsis
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("syncFailureKey", () => {
  it("signs on the sorted distinct op+status pairs (dedupe; order-insensitive)", () => {
    const failures: SyncFailure[] = [
      { op: "invite", target: "a@x.com", error: axiosErr(422, VALIDATION_422) },
      { op: "invite", target: "b@x.com", error: axiosErr(422, VALIDATION_422) },
      { op: "group-read", target: "G1", error: axiosErr(500, undefined) },
    ];
    expect(syncFailureKey(failures)).toBe("sync-failure-group-read500-invite422");
    expect(syncFailureKey([...failures].reverse())).toBe("sync-failure-group-read500-invite422");
  });

  it("is STABLE while the same condition persists (the daily throttle depends on it)", () => {
    // Different targets, same op+status => same key => the second run of the day is throttled.
    const a: SyncFailure[] = [{ op: "invite", target: "a@x.com", error: axiosErr(422, VALIDATION_422) }];
    const b: SyncFailure[] = [{ op: "invite", target: "b@x.com", error: axiosErr(422, VALIDATION_422) }];
    expect(syncFailureKey(a)).toBe(syncFailureKey(b));
  });

  it("keys a NEW failure mode differently, so it alerts the same day", () => {
    const morning: SyncFailure[] = [{ op: "invite", target: "a@x.com", error: axiosErr(422, {}) }];
    const noon: SyncFailure[] = [
      { op: "invite", target: "a@x.com", error: axiosErr(422, {}) },
      { op: "team-update", target: "b@x.com", error: axiosErr(500, undefined) },
    ];
    expect(syncFailureKey(morning)).not.toBe(syncFailureKey(noon));
  });

  it("marks non-HTTP errors as err", () => {
    expect(syncFailureKey([{ op: "delete", target: "a@x.com", error: new Error("boom") }])).toBe(
      "sync-failure-deleteerr"
    );
  });
});

describe("syncFailureSubject / syncFailureBody", () => {
  const failures: SyncFailure[] = [
    { op: "invite", target: "jayvid.parra@corespecialty.com", error: axiosErr(422, VALIDATION_422) },
    { op: "group-read", target: "d637982d-0d94-4d22-8065-0d39607ebd50", error: axiosErr(500, undefined) },
  ];

  it("subject counts the errors and names the environment", () => {
    expect(syncFailureSubject(failures, "Production")).toBe(
      "Helpdesk relay: team sync failing (2 errors) — Production"
    );
    expect(syncFailureSubject(failures.slice(0, 1), undefined)).toBe(
      "Helpdesk relay: team sync failing (1 error) — unknown"
    );
  });

  it("body lists each failure with its op, target, and rendered error", () => {
    const body = syncFailureBody(failures);
    expect(body).toContain("invite jayvid.parra@corespecialty.com — HTTP 422 validation");
    expect(body).toContain("group-read d637982d-0d94-4d22-8065-0d39607ebd50 — HTTP 500");
    expect(body).toContain("Application Insights");
  });
});

describe("sendSyncFailureAlert (through the real engine)", () => {
  const failures: SyncFailure[] = [
    { op: "invite", target: "jayvid.parra@corespecialty.com", error: axiosErr(422, VALIDATION_422) },
  ];

  function opts(over: Record<string, unknown> = {}) {
    return {
      graph,
      agents: [
        { ID: "a1", email: "dev@corespecialty.com", roles: ["owner"], teamIDs: [IT_PROD] },
      ] as HelpdeskAgent[],
      failures,
      environment: "Production",
      log: jest.fn(),
      client,
      now: () => new Date("2026-07-10T14:00:00Z"),
      ...over,
    };
  }

  it("routes to the IT team under the failure-signature key", async () => {
    mock.onPut("/relay-state?restype=container").reply(201);
    mock.onPut(/\/relay-state\/alert-/).reply(201);

    await expect(sendSyncFailureAlert(opts())).resolves.toBe("sent");

    expect(sendMailViaGraph).toHaveBeenCalledTimes(1);
    const [call] = (sendMailViaGraph as jest.Mock).mock.calls[0];
    expect(call.to).toBe("dev@corespecialty.com");
    expect(call.subject).toBe("Helpdesk relay: team sync failing (1 error) — Production");
    // The details are JSON-serialized into the line, so the inner quotes arrive escaped.
    expect(call.body).toContain('\\"status\\" is not allowed');
    expect(
      mock.history.put.some((p) => p.url?.includes("alert-production-it-sync-failure-invite422-2026-07-10"))
    ).toBe(true);
  });

  it("DOES send in Development — unlike licensing, IT alerts are routed there", async () => {
    mock.onPut("/relay-state?restype=container").reply(201);
    mock.onPut(/\/relay-state\/alert-/).reply(201);

    await expect(
      sendSyncFailureAlert(
        opts({
          environment: "Development",
          agents: [{ ID: "a1", email: "dev@corespecialty.com", roles: ["owner"], teamIDs: [IT_DEV] }],
        })
      )
    ).resolves.toBe("sent");
    expect(sendMailViaGraph).toHaveBeenCalledTimes(1);
    const [call] = (sendMailViaGraph as jest.Mock).mock.calls[0];
    expect(call.subject).toContain("— Development");
  });
});
