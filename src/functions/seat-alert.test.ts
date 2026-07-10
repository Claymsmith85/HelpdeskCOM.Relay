// Unit tests for the seat-limit (licensing) alert definition (seat-alert.ts). The engine it sits
// on — routing, throttle, recipients, kill switches — has its own suite (alerts.test.ts); here we
// pin the CLASSIFIER (seatLimitFromError), the mail content, and the definition-to-engine wiring
// by driving sendSeatLimitAlert through the REAL engine with an injected storage client.

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
import { seatAlertBody, seatAlertSubject, seatLimitFromError, sendSeatLimitAlert } from "./seat-alert";

const LICENSING_PROD = ALERT_TEAMS_BY_ENV.Production.licensing!;
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

describe("seatAlertBody", () => {
  it("names the blocked users, the shortfall, and the resolution", () => {
    const body = seatAlertBody({
      info: { message: "agents count (15) is greater than subscription allows (14)", lackingSeats: 1 },
      blocked: [
        { email: "jayvid.parra@corespecialty.com", name: "Jayvid Parra" },
        { email: "nameless@corespecialty.com" },
      ],
    });
    expect(body).toContain("Jayvid Parra <jayvid.parra@corespecialty.com>");
    expect(body).toContain("- nameless@corespecialty.com");
    expect(body).toContain("Additional licenses needed: 1");
    expect(body).toContain("purchase additional agent licenses");
  });
});

describe("sendSeatLimitAlert (through the real engine)", () => {
  const blocked = [{ email: "jayvid.parra@corespecialty.com", name: "Jayvid Parra" }];
  const info = { message: "agents count (15) is greater than subscription allows (14)", lackingSeats: 1 };
  const agents: HelpdeskAgent[] = [
    { ID: "a1", email: "boss@corespecialty.com", roles: ["normal"], teamIDs: [LICENSING_PROD] },
  ];

  function opts(over: Record<string, unknown> = {}) {
    return {
      graph,
      agents,
      blocked,
      info,
      environment: "Production",
      log: jest.fn(),
      client,
      now: () => new Date("2026-07-10T14:00:00Z"),
      ...over,
    };
  }

  it("routes to licensing under the stable seat-limit key, with the actionable content", async () => {
    mock.onPut("/relay-state?restype=container").reply(201);
    mock.onPut(/\/relay-state\/alert-/).reply(201);

    await expect(sendSeatLimitAlert(opts())).resolves.toBe("sent");

    expect(sendMailViaGraph).toHaveBeenCalledTimes(1);
    const [call] = (sendMailViaGraph as jest.Mock).mock.calls[0];
    expect(call.to).toBe("boss@corespecialty.com");
    expect(call.mailbox).toBe("escape@corespecialty.com");
    expect(call.subject).toBe(
      "Helpdesk agent licenses exhausted (1 more needed) — 1 user could not be added"
    );
    // The body must name who was blocked and how many seats are short — that's the actionable part.
    expect(call.body).toContain("Jayvid Parra <jayvid.parra@corespecialty.com>");
    expect(call.body).toContain("Additional licenses needed: 1");
    expect(call.body).toContain("Environment: Production"); // the engine's footer
    // Claimed under licensing/seat-limit for the ET day of the injected clock.
    expect(
      mock.history.put.some((p) => p.url?.includes("alert-production-licensing-seat-limit-2026-07-10"))
    ).toBe(true);
  });

  it("sends nothing in Development — no licensing team is mapped there", async () => {
    await expect(sendSeatLimitAlert(opts({ environment: "Development" }))).resolves.toBe(
      "not-configured"
    );
    expect(sendMailViaGraph).not.toHaveBeenCalled();
    expect(mock.history.put).toHaveLength(0); // never even touches storage
  });
});
