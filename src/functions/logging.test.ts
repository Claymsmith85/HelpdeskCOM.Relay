// Tests for the shared logging helpers (logging.ts). The load-bearing one here is
// summarizeRequestBody: Helpdesk request bodies carry customer email content, so the per-call
// telemetry must describe them by SHAPE ONLY. A regression that starts emitting values would put
// customer mail into Application Insights, which is exactly what these assertions prevent.

import { summarizeRequestBody } from "./logging";

describe("summarizeRequestBody", () => {
  it("returns undefined for an empty body", () => {
    expect(summarizeRequestBody(undefined)).toBeUndefined();
    expect(summarizeRequestBody(null)).toBeUndefined();
    expect(summarizeRequestBody("")).toBeUndefined();
  });

  it("reports top-level field names and byte size for an object", () => {
    const summary = summarizeRequestBody({
      subject: "Need help",
      message: { text: "customer wrote this" },
      requester: { email: "john@example.com" },
    });

    expect(summary?.fields).toEqual(["subject", "message", "requester"]);
    expect(summary?.bytes).toBeGreaterThan(0);
  });

  it("parses an already-serialized JSON string (axios serializes before the interceptor sees it)", () => {
    const raw = JSON.stringify({ customFields: { inbox: "escape@corespecialty.com" }, teamId: "T" });

    const summary = summarizeRequestBody(raw);

    expect(summary?.fields).toEqual(["customFields", "teamId"]);
    expect(summary?.bytes).toBe(Buffer.byteLength(raw, "utf8"));
  });

  it("NEVER includes values — not from an object, not from a JSON string", () => {
    const secret = "SENSITIVE-CUSTOMER-BODY";
    const forObject = summarizeRequestBody({ message: { text: secret }, to: "john@example.com" });
    const forString = summarizeRequestBody(JSON.stringify({ message: { text: secret } }));

    for (const summary of [forObject, forString]) {
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("john@example.com");
    }
  });

  it("reports size without guessing a shape for a non-JSON string body", () => {
    expect(summarizeRequestBody("grant_type=client_credentials")).toEqual({
      bytes: 29,
      fields: [],
    });
  });

  it("describes an array body by length rather than by index keys", () => {
    expect(summarizeRequestBody([{ a: 1 }, { b: 2 }])?.fields).toEqual(["[2 items]"]);
  });

  it("caps a pathological field list", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 40; i++) wide[`f${i}`] = i;

    const fields = summarizeRequestBody(wide)?.fields ?? [];

    expect(fields).toHaveLength(26); // 25 names + the "…+N more" marker
    expect(fields.at(-1)).toBe("…+15 more");
  });
});
