// Tests for the shared env helpers (env.ts). No @azure/functions side effects, so the module is
// imported directly.

import {
  agentNoticesEnabled,
  envFlag,
  envInstantMs,
  envPositiveNumber,
  followersNoticesEnabled,
  mailboxDrainEnabled,
  requireEnv,
  submitterRepliesEnabled,
  ticketCreateEnabled,
  userMgmtEnabled,
} from "./env";

describe("envPositiveNumber", () => {
  const DEFAULT = 100 * 1024 * 1024;

  it("uses a valid positive numeric value", () => {
    expect(envPositiveNumber("5242880", DEFAULT)).toBe(5242880);
  });
  it("falls back to the default when unset", () => {
    expect(envPositiveNumber(undefined, DEFAULT)).toBe(DEFAULT);
  });
  it('falls back on a non-numeric value (e.g. "100mb")', () => {
    expect(envPositiveNumber("100mb", DEFAULT)).toBe(DEFAULT);
  });
  it("falls back on zero / negative", () => {
    expect(envPositiveNumber("0", DEFAULT)).toBe(DEFAULT);
    expect(envPositiveNumber("-1", DEFAULT)).toBe(DEFAULT);
  });
  it("floors the result when { integer: true }", () => {
    expect(envPositiveNumber("10.7", 5, { integer: true })).toBe(10);
    expect(envPositiveNumber("10.7", 5)).toBe(10.7);
  });
});

describe("envInstantMs", () => {
  const FALLBACK = "2026-06-19T22:00:00Z";
  const FALLBACK_MS = Date.parse(FALLBACK);

  it("parses an ISO-8601 UTC value", () => {
    expect(envInstantMs("2026-06-20T00:00:00Z", FALLBACK)).toBe(Date.parse("2026-06-20T00:00:00Z"));
  });
  it("parses an offset value to the same instant as its UTC equivalent", () => {
    // 6:00 PM US Eastern (EDT, UTC-4) == 22:00 UTC
    expect(envInstantMs("2026-06-19T18:00:00-04:00", FALLBACK)).toBe(FALLBACK_MS);
  });
  it("falls back when unset", () => {
    expect(envInstantMs(undefined, FALLBACK)).toBe(FALLBACK_MS);
  });
  it("falls back on an unparseable value", () => {
    expect(envInstantMs("not-a-date", FALLBACK)).toBe(FALLBACK_MS);
  });
  it("falls back on an empty string", () => {
    expect(envInstantMs("", FALLBACK)).toBe(FALLBACK_MS);
  });
});

describe("envFlag", () => {
  it("treats true-ish values (case/whitespace-insensitive) as ON", () => {
    for (const v of ["true", "TRUE", " On ", "on", "1", "yes", "YES"]) {
      expect(envFlag(v, false)).toBe(true);
    }
  });
  it("treats false-ish values as OFF", () => {
    for (const v of ["false", "FALSE", " Off ", "off", "0", "no", "NO"]) {
      expect(envFlag(v, true)).toBe(false);
    }
  });
  it("returns the fallback for unset / empty / unrecognized values", () => {
    expect(envFlag(undefined, true)).toBe(true);
    expect(envFlag(undefined, false)).toBe(false);
    expect(envFlag("", true)).toBe(true);
    expect(envFlag("   ", false)).toBe(false);
    expect(envFlag("maybe", true)).toBe(true);
    expect(envFlag("maybe", false)).toBe(false);
  });
});

describe("mail feature switches (default OFF)", () => {
  const keys = [
    "MAILBOX_DRAIN",
    "TICKET_CREATE",
    "SUBMITTER_REPLIES",
    "AGENT_NOTICES",
    "FOLLOWERS_NOTICES",
  ] as const;

  afterEach(() => {
    for (const key of keys) delete process.env[key];
  });

  it("default OFF when the variable is unset or empty", () => {
    for (const key of keys) delete process.env[key];
    expect(mailboxDrainEnabled()).toBe(false);
    expect(ticketCreateEnabled()).toBe(false);
    expect(submitterRepliesEnabled()).toBe(false);
    expect(agentNoticesEnabled()).toBe(false);
    expect(followersNoticesEnabled()).toBe(false);

    for (const key of keys) process.env[key] = "";
    expect(mailboxDrainEnabled()).toBe(false);
    expect(ticketCreateEnabled()).toBe(false);
    expect(submitterRepliesEnabled()).toBe(false);
    expect(agentNoticesEnabled()).toBe(false);
    expect(followersNoticesEnabled()).toBe(false);
  });

  it("ON only when explicitly enabled", () => {
    process.env.MAILBOX_DRAIN = "true";
    process.env.TICKET_CREATE = "on";
    process.env.SUBMITTER_REPLIES = "1";
    process.env.AGENT_NOTICES = "yes";
    process.env.FOLLOWERS_NOTICES = "TRUE";
    expect(mailboxDrainEnabled()).toBe(true);
    expect(ticketCreateEnabled()).toBe(true);
    expect(submitterRepliesEnabled()).toBe(true);
    expect(agentNoticesEnabled()).toBe(true);
    expect(followersNoticesEnabled()).toBe(true);
  });

  it("OFF when explicitly disabled", () => {
    process.env.MAILBOX_DRAIN = "false";
    process.env.TICKET_CREATE = "off";
    process.env.SUBMITTER_REPLIES = "0";
    process.env.AGENT_NOTICES = "no";
    process.env.FOLLOWERS_NOTICES = "FALSE";
    expect(mailboxDrainEnabled()).toBe(false);
    expect(ticketCreateEnabled()).toBe(false);
    expect(submitterRepliesEnabled()).toBe(false);
    expect(agentNoticesEnabled()).toBe(false);
    expect(followersNoticesEnabled()).toBe(false);
  });
});

describe("userMgmtEnabled (default OFF)", () => {
  afterEach(() => delete process.env.USERMGMT_TOGGLE);

  it("defaults OFF and respects explicit values", () => {
    delete process.env.USERMGMT_TOGGLE;
    expect(userMgmtEnabled()).toBe(false);
    process.env.USERMGMT_TOGGLE = "true";
    expect(userMgmtEnabled()).toBe(true);
    process.env.USERMGMT_TOGGLE = "false";
    expect(userMgmtEnabled()).toBe(false);
  });
});

describe("requireEnv", () => {
  const KEY = "ENV_TEST_REQUIRED_VAR";
  afterEach(() => delete process.env[KEY]);

  it("returns the value when set", () => {
    process.env[KEY] = "value";
    expect(requireEnv(KEY)).toBe("value");
  });
  it("throws naming the missing var when unset or empty", () => {
    delete process.env[KEY];
    expect(() => requireEnv(KEY)).toThrow(new RegExp(KEY));
    process.env[KEY] = "";
    expect(() => requireEnv(KEY)).toThrow(new RegExp(KEY));
  });
});
