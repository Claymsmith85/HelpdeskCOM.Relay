// Unit tests for the once-daily "Helpdesk is out of agent licenses" alert (seat-alert.ts).
//
// The storage REST boundary is mocked with axios-mock-adapter on an injected axios instance
// (opts.client), so no real Storage account or credential is needed — the same seam drain-lock.ts
// uses. Graph's sendMail is mocked at the module boundary.

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
import {
  SEAT_ALERT_FROM_MAILBOX,
  alertDateKey,
  claimDailyAlert,
  seatAlertBlobName,
  seatAlertRecipients,
  seatAlertSubject,
  seatLimitFromError,
  sendSeatLimitAlert,
} from "./seat-alert";

const MGMT = "4533d6c2-98fc-4563-855a-c5205f4c856d";
const CONTAINER = "/relay-state?restype=container";
const graph = {} as AxiosInstance;

/** The exact 409 body Helpdesk returned in production (July 2026). */
const SEAT_409 = {
  error: {
    type: "limitExceeded",
    message: "agents count (15) is greater than subscription allows (14)",
    details: { paymentMethod: "manual", lackingSeats: 1 },
  },
};

function axiosErr(status: number, data: unknown): any {
  return { isAxiosError: true, response: { status, data } };
}

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
  client = axios.create();
  mock = new MockAdapter(client);
  (sendMailViaGraph as jest.Mock).mockClear().mockResolvedValue(undefined);
});
afterEach(() => {
  mock.restore();
  process.env = OLD_ENV;
});

describe("seatLimitFromError", () => {
  it("recognises the real 409 limitExceeded body, with lackingSeats", () => {
    expect(seatLimitFromError(axiosErr(409, SEAT_409))).toEqual({
      message: "agents count (15) is greater than subscription allows (14)",
      lackingSeats: 1,
    });
  });

  it("ignores a DIFFERENT 409 — POST /agents also conflicts on a duplicate email", () => {
    const dup = { error: { type: "conflict", message: "agent with this email already exists" } };
    expect(seatLimitFromError(axiosErr(409, dup))).toBeNull();
  });

  it("ignores the 422 validation rejection", () => {
    const v = { error: { type: "validation", message: "Validation error" } };
    expect(seatLimitFromError(axiosErr(422, v))).toBeNull();
  });

  it("parses a JSON body delivered as a string (non-JSON content-type)", () => {
    expect(seatLimitFromError(axiosErr(409, JSON.stringify(SEAT_409)))?.lackingSeats).toBe(1);
  });

  it("returns null for junk: no response, no body, unparseable string, missing details", () => {
    expect(seatLimitFromError(new Error("boom"))).toBeNull();
    expect(seatLimitFromError(axiosErr(409, undefined))).toBeNull();
    expect(seatLimitFromError(axiosErr(409, "<html>502</html>"))).toBeNull();
    const noDetails = { error: { type: "limitExceeded", message: "full" } };
    expect(seatLimitFromError(axiosErr(409, noDetails))).toEqual({
      message: "full",
      lackingSeats: undefined,
    });
  });
});

describe("alertDateKey", () => {
  it("keys on the Eastern business day, not UTC", () => {
    // 02:00 UTC on Jul 11 is still 22:00 ET on Jul 10 — the alert belongs to the 10th.
    expect(alertDateKey(new Date("2026-07-11T02:00:00Z"))).toBe("2026-07-10");
    expect(alertDateKey(new Date("2026-07-11T12:00:00Z"))).toBe("2026-07-11");
  });
});

describe("seatAlertBlobName", () => {
  it("is per-environment and per-day, on a safe blob charset", () => {
    expect(seatAlertBlobName("Production", "2026-07-10")).toBe("seat-alert-production-2026-07-10");
    expect(seatAlertBlobName(undefined, "2026-07-10")).toBe("seat-alert-unknown-2026-07-10");
    expect(seatAlertBlobName("Dev/Test", "2026-07-10")).toBe("seat-alert-dev-test-2026-07-10");
  });
});

describe("claimDailyAlert", () => {
  it("claims the day on first PUT (create-if-absent)", async () => {
    mock.onPut(CONTAINER).reply(201);
    mock.onPut(/\/relay-state\/seat-alert/).reply(201);
    await expect(claimDailyAlert(client, "seat-alert-production-2026-07-10", "{}")).resolves.toBe(true);
    const put = mock.history.put.find((p) => p.url?.includes("seat-alert"))!;
    expect(put.headers?.["If-None-Match"]).toBe("*");
  });

  it("tolerates an already-existing container", async () => {
    mock.onPut(CONTAINER).reply(409);
    mock.onPut(/\/relay-state\/seat-alert/).reply(201);
    await expect(claimDailyAlert(client, "seat-alert-x", "{}")).resolves.toBe(true);
  });

  it.each([409, 412])("returns false when the blob already exists (%i)", async (status) => {
    mock.onPut(CONTAINER).reply(201);
    mock.onPut(/\/relay-state\/seat-alert/).reply(status);
    await expect(claimDailyAlert(client, "seat-alert-x", "{}")).resolves.toBe(false);
  });

  it("throws on any other storage failure (fail-closed: no mail rather than hourly mail)", async () => {
    mock.onPut(CONTAINER).reply(201);
    mock.onPut(/\/relay-state\/seat-alert/).reply(403);
    await expect(claimDailyAlert(client, "seat-alert-x", "{}")).rejects.toMatchObject({
      response: { status: 403 },
    });
  });
});

describe("seatAlertRecipients", () => {
  it("selects management-team agents, dedupes, and skips our own drain mailboxes", () => {
    const agents = [
      agent("boss@corespecialty.com", [MGMT]),
      agent("BOSS@corespecialty.com", [MGMT, "other"]), // same person, different case
      agent("agent@corespecialty.com", ["other"]), // not on the management team
      agent("escape@corespecialty.com", [MGMT]), // a drain mailbox — mailing it would loop
    ];
    expect(seatAlertRecipients(agents, MGMT)).toEqual(["boss@corespecialty.com"]);
  });

  it("returns [] when nobody is on the team", () => {
    expect(seatAlertRecipients([agent("a@x.com", ["other"])], MGMT)).toEqual([]);
  });
});

describe("seatAlertSubject", () => {
  it("names the shortfall and the blocked-user count", () => {
    expect(seatAlertSubject({ message: "m", lackingSeats: 1 }, 1)).toBe(
      "Helpdesk agent licenses exhausted (1 more needed) — 1 user could not be added"
    );
    expect(seatAlertSubject({ message: "m" }, 2)).toBe(
      "Helpdesk agent licenses exhausted — 2 users could not be added"
    );
  });
});

describe("sendSeatLimitAlert", () => {
  const blocked = [{ email: "jayvid.parra@corespecialty.com", name: "Jayvid Parra" }];
  const info = { message: "agents count (15) is greater than subscription allows (14)", lackingSeats: 1 };
  const agents = [agent("boss@corespecialty.com", [MGMT]), agent("vp@corespecialty.com", [MGMT])];

  function opts(over: Record<string, unknown> = {}) {
    return {
      graph,
      agents,
      managementTeamId: MGMT,
      blocked,
      info,
      environment: "Production",
      log: jest.fn(),
      client,
      now: () => new Date("2026-07-10T14:00:00Z"),
      ...over,
    };
  }

  it("claims the day and mails every management-team member, from the Escape mailbox", async () => {
    mock.onPut(CONTAINER).reply(201);
    mock.onPut(/\/relay-state\/seat-alert/).reply(201);

    await expect(sendSeatLimitAlert(opts())).resolves.toBe("sent");

    expect(sendMailViaGraph).toHaveBeenCalledTimes(2);
    const calls = (sendMailViaGraph as jest.Mock).mock.calls.map(([a]) => a);
    expect(calls.map((c) => c.to).sort()).toEqual(["boss@corespecialty.com", "vp@corespecialty.com"]);
    expect(calls.every((c) => c.mailbox === SEAT_ALERT_FROM_MAILBOX)).toBe(true);
    expect(SEAT_ALERT_FROM_MAILBOX).toBe("escape@corespecialty.com");
    // The body must name who was blocked and how many seats are short — that's the actionable part.
    expect(calls[0].body).toContain("Jayvid Parra <jayvid.parra@corespecialty.com>");
    expect(calls[0].body).toContain("Additional licenses needed: 1");
    // Claimed under the ET day of the injected clock.
    expect(mock.history.put.some((p) => p.url?.includes("seat-alert-production-2026-07-10"))).toBe(true);
  });

  it("sends nothing on the second run of the same day (the blob claim is already held)", async () => {
    mock.onPut(CONTAINER).reply(201);
    mock.onPut(/\/relay-state\/seat-alert/).reply(409); // another invocation claimed it

    await expect(sendSeatLimitAlert(opts())).resolves.toBe("throttled");
    expect(sendMailViaGraph).not.toHaveBeenCalled();
  });

  it("sends nothing when the environment maps no management team (Development)", async () => {
    await expect(sendSeatLimitAlert(opts({ managementTeamId: undefined }))).resolves.toBe(
      "not-configured"
    );
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(mock.history.put).toHaveLength(0); // never even touches storage
  });

  it("does not claim the day when the management team has no mailable agents", async () => {
    const only = [agent("escape@corespecialty.com", [MGMT])]; // suppressed as a drain mailbox
    await expect(sendSeatLimitAlert(opts({ agents: only }))).resolves.toBe("no-recipients");
    expect(mock.history.put).toHaveLength(0);
  });

  it("still mails the rest of the team when one recipient's send fails", async () => {
    mock.onPut(CONTAINER).reply(201);
    mock.onPut(/\/relay-state\/seat-alert/).reply(201);
    (sendMailViaGraph as jest.Mock)
      .mockRejectedValueOnce(new Error("bad mailbox"))
      .mockResolvedValueOnce(undefined);

    await expect(sendSeatLimitAlert(opts())).resolves.toBe("sent");
    expect(sendMailViaGraph).toHaveBeenCalledTimes(2);
    expect(mock.history.delete).toHaveLength(0); // the day stays claimed — someone got it
  });

  it("releases the day's claim when EVERY send fails, so the next run retries", async () => {
    mock.onPut(CONTAINER).reply(201);
    mock.onPut(/\/relay-state\/seat-alert/).reply(201);
    mock.onDelete(/\/relay-state\/seat-alert/).reply(202);
    (sendMailViaGraph as jest.Mock).mockRejectedValue(new Error("graph down"));

    await expect(sendSeatLimitAlert(opts())).resolves.toBe("no-recipients");
    expect(mock.history.delete).toHaveLength(1);
    expect(mock.history.delete[0].url).toContain("seat-alert-production-2026-07-10");
  });

  it("propagates a storage failure (fail-closed) rather than mailing unthrottled", async () => {
    mock.onPut(CONTAINER).reply(201);
    mock.onPut(/\/relay-state\/seat-alert/).reply(403);

    await expect(sendSeatLimitAlert(opts())).rejects.toMatchObject({ response: { status: 403 } });
    expect(sendMailViaGraph).not.toHaveBeenCalled();
  });
});
