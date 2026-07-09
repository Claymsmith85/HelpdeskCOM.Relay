// Unit tests for the per-mailbox drain lock (drain-lock.ts).
//
// The storage REST boundary is mocked with axios-mock-adapter on an injected axios instance
// (opts.client), so no real Storage account or credential is needed. Lease acquire/renew/release
// all PUT to the same `?comp=lease` URL, distinguished by the `x-ms-lease-action` header — the mock
// branches on that header to emulate Azure's lease state machine.
//
// @azure/identity is mocked so the (unused, because we inject a client) credential path is inert.

jest.mock("@azure/identity", () => ({
  DefaultAzureCredential: jest.fn().mockImplementation(() => ({
    getToken: jest.fn().mockResolvedValue({ token: "fake-storage-token" }),
  })),
}));

import axios, { AxiosInstance } from "axios";
import MockAdapter from "axios-mock-adapter";
import { acquireDrainLock, lockBlobName, isDrainLockEnabled } from "./drain-lock";

const MAILBOX = "escape@corespecialty.com";

function leaseAction(config: any): string {
  // axios-mock-adapter lower-cases header keys inconsistently across versions; check both.
  const h = config.headers ?? {};
  return h["x-ms-lease-action"] ?? h["X-Ms-Lease-Action"] ?? "";
}

function leaseId(config: any): string {
  const h = config.headers ?? {};
  return h["x-ms-lease-id"] ?? h["x-ms-proposed-lease-id"] ?? "";
}

/** A never-waiting sleep + deterministic clock/uuid so the bounded acquire loop runs instantly. */
function fastOpts(over: Partial<Parameters<typeof acquireDrainLock>[1]> = {}) {
  let t = 0;
  return {
    sleep: jest.fn().mockResolvedValue(undefined),
    // Each now() call advances the clock by 5s so the 30s acquire window expires after ~6 polls.
    now: jest.fn(() => (t += 5_000)),
    uuid: () => "lease-test-id",
    log: jest.fn(),
    ...over,
  };
}

let client: AxiosInstance;
let mock: MockAdapter;

beforeEach(() => {
  client = axios.create();
  mock = new MockAdapter(client);
});
afterEach(() => mock.restore());

describe("lockBlobName", () => {
  it("maps an email and a GUID to safe, stable blob names", () => {
    expect(lockBlobName("escape@corespecialty.com")).toBe("mailbox-escape-corespecialty.com.lock");
    expect(lockBlobName("7E651318-ED7B-4DE2")).toBe("mailbox-7e651318-ed7b-4de2.lock");
  });
});

describe("acquireDrainLock", () => {
  it("acquires the lease and returns a releasable lock when the blob is free", async () => {
    mock.onPut(/comp=lease/).reply((config) => {
      if (leaseAction(config) === "acquire") return [201, "", { "x-ms-lease-id": "lease-test-id" }];
      if (leaseAction(config) === "release") return [200, ""];
      return [400, ""];
    });

    const lock = await acquireDrainLock(MAILBOX, { client, ...fastOpts() });

    expect(lock).not.toBeNull();
    expect(lock!.mailbox).toBe(MAILBOX);

    await lock!.release();
    const released = mock.history.put.find((p) => leaseAction(p) === "release");
    expect(released).toBeDefined();
    expect(leaseId(released)).toBe("lease-test-id");
  });

  it("creates the container + blob on first use (404) then acquires", async () => {
    let acquireAttempts = 0;
    mock.onPut(/comp=lease/).reply((config) => {
      if (leaseAction(config) === "acquire") {
        acquireAttempts++;
        // First attempt: blob doesn't exist yet -> 404. After ensure, the second succeeds.
        return acquireAttempts === 1
          ? [404, ""]
          : [201, "", { "x-ms-lease-id": "lease-test-id" }];
      }
      return [200, ""];
    });
    // Container + blob creation PUTs (no comp=lease).
    mock.onPut(/restype=container/).reply(201, "");
    mock.onPut(/drain-locks\//).reply(201, "");

    const lock = await acquireDrainLock(MAILBOX, { client, ...fastOpts() });

    expect(lock).not.toBeNull();
    expect(acquireAttempts).toBe(2);
    // The container PUT happened.
    expect(mock.history.put.some((p) => /restype=container/.test(p.url ?? ""))).toBe(true);
  });

  it("tolerates an already-existing container (409) and blob (409) during ensure", async () => {
    let acquireAttempts = 0;
    mock.onPut(/comp=lease/).reply((config) => {
      if (leaseAction(config) === "acquire") {
        acquireAttempts++;
        return acquireAttempts === 1
          ? [404, ""]
          : [201, "", { "x-ms-lease-id": "lease-test-id" }];
      }
      return [200, ""];
    });
    mock.onPut(/restype=container/).reply(409, ""); // ContainerAlreadyExists
    mock.onPut(/drain-locks\//).reply(409, ""); // BlobAlreadyExists (If-None-Match:*)

    const lock = await acquireDrainLock(MAILBOX, { client, ...fastOpts() });

    expect(lock).not.toBeNull();
  });

  it("returns null (defer) when the lease is held by another instance for the whole window", async () => {
    mock.onPut(/comp=lease/).reply((config) =>
      leaseAction(config) === "acquire" ? [409, ""] : [200, ""]
    );
    const opts = fastOpts();

    const lock = await acquireDrainLock(MAILBOX, { client, ...opts });

    expect(lock).toBeNull();
    // It polled (slept) at least once while contended.
    expect(opts.sleep).toHaveBeenCalled();
  });

  it("acquires on a later poll once the holder releases", async () => {
    let attempts = 0;
    mock.onPut(/comp=lease/).reply((config) => {
      if (leaseAction(config) === "acquire") {
        attempts++;
        // Held for the first two attempts, then free.
        return attempts < 3 ? [409, ""] : [201, "", { "x-ms-lease-id": "lease-test-id" }];
      }
      return [200, ""];
    });

    const lock = await acquireDrainLock(MAILBOX, { client, ...fastOpts() });

    expect(lock).not.toBeNull();
    expect(attempts).toBe(3);
  });

  it("throws on an unexpected storage error (fail safe — caller will not drain unlocked)", async () => {
    mock.onPut(/comp=lease/).reply((config) =>
      leaseAction(config) === "acquire" ? [403, ""] : [200, ""]
    );

    await expect(acquireDrainLock(MAILBOX, { client, ...fastOpts() })).rejects.toBeTruthy();
  });

  it("renews the lease on the scheduled interval", async () => {
    mock.onPut(/comp=lease/).reply((config) => {
      if (leaseAction(config) === "acquire") return [201, "", { "x-ms-lease-id": "lease-test-id" }];
      return [200, ""]; // renew + release
    });

    // Capture the renewal callback instead of using a real timer.
    let renewFn: (() => void) | null = null;
    const setTimer = jest.fn((fn: () => void) => {
      renewFn = fn;
      return { clear: jest.fn() };
    });

    const lock = await acquireDrainLock(MAILBOX, { client, ...fastOpts(), setTimer });
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(renewFn).toBeInstanceOf(Function);

    // Fire one renewal tick and let its async PUT settle.
    renewFn!();
    await new Promise((r) => setImmediate(r));

    const renew = mock.history.put.find((p) => leaseAction(p) === "renew");
    expect(renew).toBeDefined();
    expect(leaseId(renew)).toBe("lease-test-id");
    expect(lock!.lost).toBe(false); // a successful renewal keeps the lock held

    await lock!.release();
  });

  it("marks the lock as lost when a renewal fails (so the drain can abort)", async () => {
    mock.onPut(/comp=lease/).reply((config) => {
      if (leaseAction(config) === "acquire") return [201, "", { "x-ms-lease-id": "lease-test-id" }];
      if (leaseAction(config) === "renew") return [403, ""]; // e.g. RBAC/permission lost mid-drain
      return [200, ""]; // release
    });
    let renewFn: (() => void) | null = null;
    const setTimer = jest.fn((fn: () => void) => {
      renewFn = fn;
      return { clear: jest.fn() };
    });

    const lock = await acquireDrainLock(MAILBOX, { client, ...fastOpts(), setTimer });
    expect(lock!.lost).toBe(false);

    renewFn!();
    await new Promise((r) => setImmediate(r));

    expect(lock!.lost).toBe(true);

    await lock!.release();
  });

  it("stops the renewal timer on release", async () => {
    mock.onPut(/comp=lease/).reply((config) =>
      leaseAction(config) === "acquire" ? [201, "", { "x-ms-lease-id": "lease-test-id" }] : [200, ""]
    );
    const clear = jest.fn();
    const setTimer = jest.fn(() => ({ clear }));

    const lock = await acquireDrainLock(MAILBOX, { client, ...fastOpts(), setTimer });
    await lock!.release();

    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("isDrainLockEnabled", () => {
  it("is enabled by default", () => {
    expect(isDrainLockEnabled()).toBe(true);
  });

  it("returns a no-op lock and makes no storage calls when DRAIN_LOCK_ENABLED=false", async () => {
    await jest.isolateModulesAsync(async () => {
      process.env.DRAIN_LOCK_ENABLED = "false";
      // Re-require under the disabled flag (read once at module load).
      const dl = require("./drain-lock") as typeof import("./drain-lock");
      const c = axios.create();
      const m = new MockAdapter(c);

      expect(dl.isDrainLockEnabled()).toBe(false);
      const lock = await dl.acquireDrainLock(MAILBOX, { client: c });
      expect(lock).not.toBeNull();
      await lock!.release();
      expect(m.history.put).toHaveLength(0); // never touched storage

      m.restore();
      delete process.env.DRAIN_LOCK_ENABLED;
    });
  });
});
