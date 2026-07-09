// Tests for the thin sync-teams timer handler. Importing the module registers app.timer, so
// @azure/functions is mocked to a no-op registry. The orchestration (runTeamSync) is mocked at the
// module boundary — this only verifies the handler's wiring: it runs the sync, surfaces a removal
// cap at ERROR severity WITHOUT failing, and rethrows on failure.

jest.mock("@azure/functions", () => ({
  app: { http: jest.fn(), setup: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() },
}));
jest.mock("./graph-client", () => ({ createGraphClientFromEnv: jest.fn(async () => ({})) }));
jest.mock("./helpdesk-client", () => ({ createHelpdeskClient: jest.fn(() => ({})) }));
jest.mock("./team-sync", () => ({
  runTeamSync: jest.fn(),
  teamSyncOptionsFromEnv: jest.fn(() => ({ dryRun: false })),
}));

import { syncTeams } from "./sync-teams";
import { runTeamSync } from "./team-sync";

const runMock = runTeamSync as jest.Mock;

function fakeContext() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    functionName: "sync-teams",
    invocationId: "test-inv",
  } as any;
}

beforeEach(() => {
  // User management is OFF by default (default-OFF master switch); these tests exercise the enabled
  // behavior. The disabled path has its own test below.
  process.env.USERMGMT_TOGGLE = "true";
});

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.USERMGMT_TOGGLE;
});

const summary = (over: Record<string, any> = {}) => ({
  skipped: false,
  applied: true,
  invited: 0,
  updated: 0,
  deleted: 0,
  plannedRemovals: 0,
  removalsCapped: false,
  groupReadFailures: 0,
  failed: 0,
  // Healthy defaults: groups were read and AAD resolved to some agents, so the all-empty ERROR
  // branch stays quiet unless a test opts into it.
  groupsConfigured: 2,
  groupsEmpty: 0,
  desiredAgents: 3,
  existingAgents: 3,
  ...over,
});

describe("syncTeams handler", () => {
  it("runs the sync and does not log an error on a clean run", async () => {
    runMock.mockResolvedValue(summary());
    const ctx = fakeContext();

    await syncTeams({} as any, ctx);

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it("surfaces a removal-cap breach at ERROR severity but does NOT throw", async () => {
    runMock.mockResolvedValue(summary({ removalsCapped: true, plannedRemovals: 9 }));
    const ctx = fakeContext();

    await expect(syncTeams({} as any, ctx)).resolves.toBeUndefined();
    expect(ctx.error).toHaveBeenCalledTimes(1);
  });

  it("surfaces an all-groups-empty read at ERROR severity but does NOT throw", async () => {
    // 0 members resolved across all configured groups (the permissions/identity tell-tale).
    runMock.mockResolvedValue(summary({ groupsConfigured: 6, groupsEmpty: 6, desiredAgents: 0 }));
    const ctx = fakeContext();

    await expect(syncTeams({} as any, ctx)).resolves.toBeUndefined();
    expect(ctx.error).toHaveBeenCalledTimes(1);
  });

  it("rethrows when the sync fails", async () => {
    runMock.mockRejectedValue(new Error("boom"));
    const ctx = fakeContext();

    await expect(syncTeams({} as any, ctx)).rejects.toThrow(/boom/);
    expect(ctx.error).toHaveBeenCalled(); // stepError logged before rethrow
  });

  it("does nothing when USERMGMT_TOGGLE is off", async () => {
    process.env.USERMGMT_TOGGLE = "false";
    const ctx = fakeContext();

    await syncTeams({} as any, ctx);

    expect(runMock).not.toHaveBeenCalled();
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it("does nothing when USERMGMT_TOGGLE is unset (default OFF)", async () => {
    delete process.env.USERMGMT_TOGGLE;
    const ctx = fakeContext();

    await syncTeams({} as any, ctx);

    expect(runMock).not.toHaveBeenCalled();
  });
});
