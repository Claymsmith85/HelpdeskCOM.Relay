// Tests for runTeamSync's change-alert wiring: the once-daily `changes` digest fires exactly when
// a run APPLIED something (successful invites / team updates / deletes) — never on a no-op run, a
// dry run, or failures-only — and its own failure never changes the sync's outcome. The Helpdesk /
// Graph boundaries and the alert definitions are mocked at the module boundary.

jest.mock("./graph-directory", () => ({ listGroupMemberUsers: jest.fn() }));
jest.mock("./helpdesk-client", () => ({
  listAgents: jest.fn(),
  listTeams: jest.fn(),
  inviteAgent: jest.fn(),
  updateAgentTeams: jest.fn(),
  deleteAgent: jest.fn(),
}));
jest.mock("./seat-alert", () => ({
  seatLimitFromError: jest.fn(() => null),
  sendSeatLimitAlert: jest.fn(async () => "sent"),
}));
jest.mock("./sync-failure-alert", () => ({ sendSyncFailureAlert: jest.fn(async () => "sent") }));
jest.mock("./sync-change-alert", () => ({
  ...jest.requireActual("./sync-change-alert"),
  sendSyncChangeAlert: jest.fn(async () => "sent"),
}));

import { listGroupMemberUsers } from "./graph-directory";
import {
  deleteAgent,
  inviteAgent,
  listAgents,
  listTeams,
  updateAgentTeams,
} from "./helpdesk-client";
import { sendSyncChangeAlert } from "./sync-change-alert";
import { sendSyncFailureAlert } from "./sync-failure-alert";
import { runTeamSync, TeamSyncOptions } from "./team-sync";

const membersMock = listGroupMemberUsers as jest.Mock;
const agentsMock = listAgents as jest.Mock;
const teamsMock = listTeams as jest.Mock;
const inviteMock = inviteAgent as jest.Mock;
const updateMock = updateAgentTeams as jest.Mock;
const deleteMock = deleteAgent as jest.Mock;
const changeAlertMock = sendSyncChangeAlert as jest.Mock;
const failureAlertMock = sendSyncFailureAlert as jest.Mock;

const G1 = "11111111-1111-1111-1111-111111111111";
const T1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const T_MANUAL = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const opts = (over: Partial<TeamSyncOptions> = {}): TeamSyncOptions => ({
  rules: [{ group: G1, team: T1, role: "normal" }],
  maxRemovals: 5,
  defaultRole: "normal",
  dryRun: false,
  cleanupOrphans: true,
  protectedEmails: new Set<string>(),
  environment: "Production",
  ...over,
});

beforeEach(() => {
  // Default happy path: AAD wants alice; Helpdesk has bob (loses T1, keeps a manual team) and
  // carol (loses T1, fully orphaned -> delete). One invite + one update + one delete.
  membersMock.mockResolvedValue([
    { email: "alice@corespecialty.com", name: "Alice", accountEnabled: true },
  ]);
  agentsMock.mockResolvedValue([
    { ID: "b1", email: "bob@corespecialty.com", teamIDs: [T1, T_MANUAL] },
    { ID: "c1", email: "carol@corespecialty.com", teamIDs: [T1] },
  ]);
  teamsMock.mockResolvedValue([{ ID: T1, name: "Escape" }, { ID: T_MANUAL, name: "Manual" }]);
  inviteMock.mockResolvedValue("new-agent-id");
  updateMock.mockResolvedValue(undefined);
  deleteMock.mockResolvedValue(undefined);
  changeAlertMock.mockResolvedValue("sent");
});

afterEach(() => jest.clearAllMocks());

describe("runTeamSync change alert", () => {
  it("sends one digest of exactly the changes the run applied, with resolved team names", async () => {
    const summary = await runTeamSync({} as any, {} as any, opts());

    expect(summary.invited).toBe(1);
    expect(summary.updated).toBe(1);
    expect(summary.deleted).toBe(1);
    expect(summary.changeAlert).toBe("sent");

    expect(changeAlertMock).toHaveBeenCalledTimes(1);
    const call = changeAlertMock.mock.calls[0][0];
    expect(call.environment).toBe("Production");
    expect(call.teamNames).toEqual({ [T1]: "Escape", [T_MANUAL]: "Manual" });
    expect(call.changes).toEqual({
      invited: [
        { email: "alice@corespecialty.com", name: "Alice", roles: ["normal"], teamIDs: [T1] },
      ],
      updated: [{ email: "bob@corespecialty.com", added: [], removed: [T1] }],
      deleted: [{ email: "carol@corespecialty.com" }],
    });
  });

  it("does not alert when the run changed nothing", async () => {
    // Helpdesk already matches AAD exactly: alice on T1, nobody else.
    agentsMock.mockResolvedValue([{ ID: "a1", email: "alice@corespecialty.com", teamIDs: [T1] }]);

    const summary = await runTeamSync({} as any, {} as any, opts());

    expect(summary.invited + summary.updated + summary.deleted).toBe(0);
    expect(summary.changeAlert).toBeUndefined();
    expect(changeAlertMock).not.toHaveBeenCalled();
  });

  it("does not alert on a dry run (nothing was applied)", async () => {
    const summary = await runTeamSync({} as any, {} as any, opts({ dryRun: true }));

    expect(summary.applied).toBe(false);
    expect(inviteMock).not.toHaveBeenCalled();
    expect(changeAlertMock).not.toHaveBeenCalled();
  });

  it("does not alert when every attempted change failed (that's the failure alerts' job)", async () => {
    // Only an invite is planned, and it is rejected (non-seat) -> IT failure alert, no change alert.
    agentsMock.mockResolvedValue([]);
    inviteMock.mockRejectedValue(new Error("500"));

    await expect(runTeamSync({} as any, {} as any, opts())).rejects.toThrow(/1 change/);

    expect(changeAlertMock).not.toHaveBeenCalled();
    expect(failureAlertMock).toHaveBeenCalledTimes(1);
  });

  it("still alerts with raw team IDs when the team-name lookup fails", async () => {
    teamsMock.mockRejectedValue(new Error("teams down"));

    const summary = await runTeamSync({} as any, {} as any, opts());

    expect(summary.changeAlert).toBe("sent");
    expect(changeAlertMock.mock.calls[0][0].teamNames).toBeUndefined();
  });

  it("a change-alert failure never fails the sync (best-effort by contract)", async () => {
    changeAlertMock.mockRejectedValue(new Error("mail down"));

    const summary = await runTeamSync({} as any, {} as any, opts());

    expect(summary.failed).toBe(0);
    expect(summary.changeAlert).toBeUndefined();
  });
});
