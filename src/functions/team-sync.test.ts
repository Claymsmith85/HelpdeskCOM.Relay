// Tests for team-sync.ts: the rule parser, role collapsing, the pure reconciler planTeamSync (the
// crux), and the runTeamSync orchestration (Graph + Helpdesk mocked with axios-mock-adapter on
// injected clients). No @azure/functions side effects — the timer lives in sync-teams.ts.

// The alerts have their own suites (alerts/seat-alert/sync-failure-alert .test.ts); here we only
// assert runTeamSync WIRES them up — which failures land in which alert — so the sends are stubbed
// while the real seatLimitFromError still classifies each error.
jest.mock("./seat-alert", () => ({
  ...jest.requireActual("./seat-alert"),
  sendSeatLimitAlert: jest.fn().mockResolvedValue("sent"),
}));
jest.mock("./sync-failure-alert", () => ({
  ...jest.requireActual("./sync-failure-alert"),
  sendSyncFailureAlert: jest.fn().mockResolvedValue("sent"),
}));

import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import {
  bestRole,
  planTeamSync,
  runTeamSync,
  DesiredState,
  DesiredAgent,
  TeamSyncOptions,
} from "./team-sync";
import { HelpdeskAgent } from "./helpdesk-client";
import { sendSeatLimitAlert } from "./seat-alert";
import { sendSyncFailureAlert } from "./sync-failure-alert";

// ---- helpers ----

const wantAgent = (
  email: string,
  roles: string[],
  teams: string[],
  name = email
): [string, DesiredAgent] => [email, { email, name, roles: new Set(roles), teams: new Set(teams) }];

function desired(
  entries: Array<[string, DesiredAgent]>,
  suppressed: string[] = []
): DesiredState {
  return { agents: new Map(entries), suppressedTeams: new Set(suppressed) };
}

const agent = (over: Partial<HelpdeskAgent> & { ID: string; email: string }): HelpdeskAgent => ({
  roles: ["normal"],
  teamIDs: [],
  status: "active",
  ...over,
});

describe("bestRole", () => {
  it("picks the most-privileged role (owner > normal > viewer)", () => {
    expect(bestRole(["viewer", "owner", "normal"], "normal")).toBe("owner");
    expect(bestRole(["viewer", "normal"], "normal")).toBe("normal");
    expect(bestRole(["viewer"], "normal")).toBe("viewer");
  });
  it("falls back when the set is empty", () => {
    expect(bestRole([], "normal")).toBe("normal");
  });
});

describe("planTeamSync", () => {
  const mapped = new Set(["T1", "T2"]);

  it("adds a mapped team to an existing agent, preserving non-mapped teams", () => {
    const plan = planTeamSync(
      desired([wantAgent("a@x.com", ["normal"], ["T1"])]),
      [agent({ ID: "a1", email: "a@x.com", teamIDs: ["TX"] })], // TX is non-mapped/manual
      mapped,
      5,
      "normal"
    );
    expect(plan.updates).toEqual([
      { agentId: "a1", email: "a@x.com", teamIDs: ["TX", "T1"], added: ["T1"], removed: [] },
    ]);
    expect(plan.invites).toEqual([]);
    expect(plan.deletes).toEqual([]);
  });

  it("invites a desired member with no agent, into their mapped team(s) with their role", () => {
    const plan = planTeamSync(
      desired([wantAgent("new@x.com", ["normal"], ["T1", "T2"], "New One")]),
      [],
      mapped,
      5,
      "normal"
    );
    expect(plan.invites).toEqual([
      { email: "new@x.com", name: "New One", roles: ["normal"], teamIDs: ["T1", "T2"] },
    ]);
  });

  it("invites a team-less viewer with no team and the viewer role", () => {
    const plan = planTeamSync(
      desired([wantAgent("v@x.com", ["viewer"], [])]),
      [],
      mapped,
      5,
      "normal"
    );
    expect(plan.invites).toEqual([
      { email: "v@x.com", name: "v@x.com", roles: ["viewer"], teamIDs: [] },
    ]);
  });

  it("removes the mapped team when a member left; keeps a manual team (no delete)", () => {
    const plan = planTeamSync(
      desired([]), // a@x.com no longer desired
      [agent({ ID: "a1", email: "a@x.com", teamIDs: ["T1", "TX"] })],
      mapped,
      5,
      "normal"
    );
    expect(plan.updates).toEqual([
      { agentId: "a1", email: "a@x.com", teamIDs: ["TX"], added: [], removed: ["T1"] },
    ]);
    expect(plan.deletes).toEqual([]);
  });

  it("deletes an agent left with ZERO teams after losing its last mapped team", () => {
    const plan = planTeamSync(
      desired([]),
      [agent({ ID: "a1", email: "a@x.com", teamIDs: ["T1"] })],
      mapped,
      5,
      "normal"
    );
    expect(plan.deletes).toEqual([{ agentId: "a1", email: "a@x.com" }]);
    expect(plan.updates).toEqual([]);
    expect(plan.plannedRemovals).toBe(1);
  });

  it("multi-team/multi-group user leaving ONE group keeps their other team (no delete, no cross-team removal)", () => {
    // In T1 and T2; left T1's group but still in T2's group. Only T1 is removed; T2 untouched.
    const plan = planTeamSync(
      desired([wantAgent("a@x.com", ["normal"], ["T2"])]),
      [agent({ ID: "a1", email: "a@x.com", teamIDs: ["T1", "T2"] })],
      mapped,
      5,
      "normal"
    );
    expect(plan.deletes).toEqual([]);
    expect(plan.updates).toEqual([
      { agentId: "a1", email: "a@x.com", teamIDs: ["T2"], added: [], removed: ["T1"] },
    ]);
  });

  it("decommissions a multi-team user only once they are in NO group and NO team", () => {
    const plan = planTeamSync(
      desired([]), // present in no mapped group at all
      [agent({ ID: "a1", email: "a@x.com", teamIDs: ["T1", "T2"] })],
      mapped,
      5,
      "normal"
    );
    expect(plan.deletes).toEqual([{ agentId: "a1", email: "a@x.com" }]);
    expect(plan.updates).toEqual([]);
    expect(plan.plannedRemovals).toBe(2);
  });

  it("with cleanupOrphans, decommissions a pre-existing zero-team agent in no group", () => {
    const plan = planTeamSync(
      desired([]),
      [agent({ ID: "a1", email: "ghost@x.com", teamIDs: [] })], // already zero teams, no group
      mapped,
      5,
      "normal",
      { cleanupOrphans: true }
    );
    expect(plan.deletes).toEqual([{ agentId: "a1", email: "ghost@x.com" }]);
    expect(plan.plannedRemovals).toBe(1);
  });

  it("without cleanupOrphans, leaves a pre-existing zero-team orphan untouched", () => {
    const plan = planTeamSync(
      desired([]),
      [agent({ ID: "a1", email: "ghost@x.com", teamIDs: [] })],
      mapped,
      5,
      "normal"
    );
    expect(plan.deletes).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.plannedRemovals).toBe(0);
  });

  it("never deletes a protected email, and leaves it untouched rather than stranding it", () => {
    const plan = planTeamSync(
      desired([]), // owner is in no group...
      [agent({ ID: "a1", email: "owner@x.com", teamIDs: ["T1"] })], // ...and would otherwise be emptied -> deleted
      mapped,
      5,
      "normal",
      { cleanupOrphans: true, protectedEmails: new Set(["owner@x.com"]) }
    );
    expect(plan.deletes).toEqual([]);
    expect(plan.updates).toEqual([]); // not even the T1 removal applied
    expect(plan.plannedRemovals).toBe(0);
  });

  it("counts orphan deletes toward the removal cap", () => {
    const agents = [
      agent({ ID: "a1", email: "g1@x.com", teamIDs: [] }),
      agent({ ID: "a2", email: "g2@x.com", teamIDs: [] }),
      agent({ ID: "a3", email: "g3@x.com", teamIDs: [] }),
    ];
    const plan = planTeamSync(desired([]), agents, mapped, 2, "normal", { cleanupOrphans: true });
    expect(plan.removalsCapped).toBe(true);
    expect(plan.plannedRemovals).toBe(3);
    expect(plan.deletes).toEqual([]); // all dropped over the cap
  });

  it("does NOT delete a still-desired viewer who lost their mapped team (existence-only)", () => {
    // a@x.com left the T1 agent group but is still in the Viewers group (desired, no team).
    const plan = planTeamSync(
      desired([wantAgent("a@x.com", ["viewer"], [])]),
      [agent({ ID: "a1", email: "a@x.com", teamIDs: ["T1"] })],
      mapped,
      5,
      "normal"
    );
    expect(plan.deletes).toEqual([]);
    expect(plan.updates).toEqual([
      { agentId: "a1", email: "a@x.com", teamIDs: [], added: [], removed: ["T1"] },
    ]);
  });

  it("never touches non-mapped teams for an agent with no mapped membership", () => {
    const plan = planTeamSync(
      desired([]),
      [agent({ ID: "a1", email: "a@x.com", teamIDs: ["TX", "TY"] })],
      mapped,
      5,
      "normal"
    );
    expect(plan).toMatchObject({ invites: [], updates: [], deletes: [] });
  });

  it("suppresses removals for a team flagged suppressed (empty/failed group read)", () => {
    const plan = planTeamSync(
      desired([], ["T1"]),
      [agent({ ID: "a1", email: "a@x.com", teamIDs: ["T1"] })],
      mapped,
      5,
      "normal"
    );
    expect(plan.updates).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.plannedRemovals).toBe(0);
  });

  it("drops ALL removals/deletes when over the cap, but still applies adds", () => {
    const agents = [
      agent({ ID: "a1", email: "a@x.com", teamIDs: ["T1"] }),
      agent({ ID: "a2", email: "b@x.com", teamIDs: ["T1"] }),
      agent({ ID: "a3", email: "c@x.com", teamIDs: ["T1"] }),
    ];
    // All three would be removed from T1 (3 removals), cap = 2 -> capped. Plus a new add.
    const plan = planTeamSync(
      desired([wantAgent("d@x.com", ["normal"], ["T1"])]),
      agents,
      mapped,
      2,
      "normal"
    );
    expect(plan.removalsCapped).toBe(true);
    expect(plan.plannedRemovals).toBe(3);
    expect(plan.deletes).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.invites).toEqual([
      { email: "d@x.com", name: "d@x.com", roles: ["normal"], teamIDs: ["T1"] },
    ]);
  });

  it("matches agent email case-insensitively", () => {
    const plan = planTeamSync(
      desired([wantAgent("a@x.com", ["normal"], ["T1"])]),
      [agent({ ID: "a1", email: "A@X.com", teamIDs: [] })],
      mapped,
      5,
      "normal"
    );
    expect(plan.updates[0]).toMatchObject({ agentId: "a1", added: ["T1"] });
    expect(plan.invites).toEqual([]);
  });
});

describe("runTeamSync (orchestration)", () => {
  let graph: ReturnType<typeof axios.create>;
  let helpdesk: ReturnType<typeof axios.create>;
  let gmock: MockAdapter;
  let hmock: MockAdapter;

  // One team-bearing group (G1->T1, normal) and one team-less viewer group (GV, viewer).
  const opts: TeamSyncOptions = {
    rules: [
      { group: "G1", team: "T1", role: "normal" },
      { group: "GV", role: "viewer" },
    ],
    maxRemovals: 5,
    defaultRole: "normal",
    dryRun: false,
    cleanupOrphans: false,
    protectedEmails: new Set<string>(),
  };

  beforeEach(() => {
    graph = axios.create();
    helpdesk = axios.create();
    gmock = new MockAdapter(graph);
    hmock = new MockAdapter(helpdesk);
    (sendSeatLimitAlert as jest.Mock).mockClear().mockResolvedValue("sent");
    (sendSyncFailureAlert as jest.Mock).mockClear().mockResolvedValue("sent");
  });
  afterEach(() => {
    gmock.restore();
    hmock.restore();
  });

  // Reply per group id (the group id is in the request URL path).
  function mockGroups(byGroup: Record<string, any[]>) {
    gmock.onGet(/\/groups\/([^/]+)\/transitiveMembers/).reply((config) => {
      const m = /\/groups\/([^/]+)\/transitiveMembers/.exec(config.url ?? "");
      const gid = m ? decodeURIComponent(m[1]) : "";
      return [200, { value: byGroup[gid] ?? [] }];
    });
  }

  it("skips cleanly when no rules are configured", async () => {
    const res = await runTeamSync(graph, helpdesk, { ...opts, rules: [] });
    expect(res.skipped).toBe(true);
    expect(res.applied).toBe(false);
  });

  it("invites a viewer (no team) + a team agent, updates existing, deletes offboarded", async () => {
    mockGroups({
      G1: [
        { id: "1", displayName: "Keep", mail: "keep@x.com", accountEnabled: true },
        { id: "2", displayName: "NewAgent", mail: "newagent@x.com", accountEnabled: true },
      ],
      GV: [{ id: "3", displayName: "NewViewer", mail: "newviewer@x.com", accountEnabled: true }],
    });
    hmock.onGet("/agents").reply(200, [
      { ID: "a-keep", email: "keep@x.com", roles: ["normal"], teamIDs: [], status: "active" },
      // a-gone is in T1 but not in any group anymore -> zero teams -> delete
      { ID: "a-gone", email: "gone@x.com", roles: ["normal"], teamIDs: ["T1"], status: "active" },
    ]);
    hmock.onPost("/agents").reply(200, { ID: "a-new" });
    hmock.onPatch(/\/agents\/.+/).reply(200, {});
    hmock.onDelete("/agents/a-gone").reply(200, "OK");

    const res = await runTeamSync(graph, helpdesk, opts);

    expect(res).toMatchObject({ invited: 2, updated: 1, deleted: 1, failed: 0 });

    const invites = hmock.history.post.map((p) => JSON.parse(p.data));
    const viewer = invites.find((i) => i.email === "newviewer@x.com");
    const newAgent = invites.find((i) => i.email === "newagent@x.com");
    expect(viewer).toMatchObject({ roles: ["viewer"], teamIDs: [] });
    expect(newAgent).toMatchObject({ roles: ["normal"], teamIDs: ["T1"] });
    // Helpdesk 422s on a `status` key in the create body — no invite may carry one.
    for (const inv of invites) expect(inv).not.toHaveProperty("status");
    expect(hmock.history.delete[0].url).toBe("/agents/a-gone");
  });

  // The production 409 body (July 2026), verbatim.
  const SEAT_409 = {
    error: {
      type: "limitExceeded",
      message: "agents count (15) is greater than subscription allows (14)",
      details: { paymentMethod: "manual", lackingSeats: 1 },
    },
  };

  it("routes seat-limit rejections to the LICENSING alert, once, naming every blocked user", async () => {
    mockGroups({
      G1: [
        { id: "1", displayName: "Jayvid Parra", mail: "jayvid.parra@x.com", accountEnabled: true },
        { id: "2", displayName: "Second New", mail: "second@x.com", accountEnabled: true },
      ],
      GV: [],
    });
    hmock.onGet("/agents").reply(200, [
      { ID: "a-boss", email: "boss@x.com", roles: ["normal"], teamIDs: ["MGMT"], status: "active" },
    ]);
    hmock.onPost("/agents").reply(409, SEAT_409);

    const prod = { ...opts, environment: "Production" };
    // Invite failures still fail the run — the alert informs, it does not absolve.
    await expect(runTeamSync(graph, helpdesk, prod)).rejects.toThrow(/2 change\(s\)/);

    // ONE alert naming BOTH blocked users, not one per failed invite.
    expect(sendSeatLimitAlert).toHaveBeenCalledTimes(1);
    const arg = (sendSeatLimitAlert as jest.Mock).mock.calls[0][0];
    expect(arg.environment).toBe("Production");
    expect(arg.info).toEqual({
      message: "agents count (15) is greater than subscription allows (14)",
      lackingSeats: 1,
    });
    expect(arg.blocked.map((b: any) => b.email).sort()).toEqual([
      "jayvid.parra@x.com",
      "second@x.com",
    ]);
    // The agent list is passed through so the alert can resolve the routed team's members.
    expect(arg.agents).toHaveLength(1);
    // A seat limit is a licensing problem, not an IT one — devs can't fix a full subscription.
    expect(sendSyncFailureAlert).not.toHaveBeenCalled();
  });

  it("routes a NON-seat invite failure (e.g. duplicate email) to the IT alert, not licensing", async () => {
    mockGroups({ G1: [{ id: "1", displayName: "New", mail: "new@x.com", accountEnabled: true }], GV: [] });
    hmock.onGet("/agents").reply(200, []);
    hmock
      .onPost("/agents")
      .reply(409, { error: { type: "conflict", message: "agent with this email already exists" } });

    await expect(runTeamSync(graph, helpdesk, opts)).rejects.toThrow(/1 change\(s\)/);
    expect(sendSeatLimitAlert).not.toHaveBeenCalled();
    expect(sendSyncFailureAlert).toHaveBeenCalledTimes(1);
    const arg = (sendSyncFailureAlert as jest.Mock).mock.calls[0][0];
    expect(arg.failures).toHaveLength(1);
    expect(arg.failures[0]).toMatchObject({ op: "invite", target: "new@x.com" });
  });

  it("splits a mixed run: seat rejections to licensing, everything else to IT — one mail each", async () => {
    mockGroups({
      G1: [
        { id: "1", displayName: "Seatless", mail: "seatless@x.com", accountEnabled: true },
        { id: "2", displayName: "Broken", mail: "broken@x.com", accountEnabled: true },
      ],
      GV: [],
    });
    hmock.onGet("/agents").reply(200, []);
    // Invites run in desired-state (group-member) order: seatless first, broken second.
    hmock
      .onPost("/agents")
      .replyOnce(409, SEAT_409)
      .onPost("/agents")
      .replyOnce(422, { error: { type: "validation", message: "Validation error" } });

    await expect(runTeamSync(graph, helpdesk, opts)).rejects.toThrow(/2 change\(s\)/);

    expect(sendSeatLimitAlert).toHaveBeenCalledTimes(1);
    const seatArg = (sendSeatLimitAlert as jest.Mock).mock.calls[0][0];
    expect(seatArg.blocked.map((b: any) => b.email)).toEqual(["seatless@x.com"]);

    expect(sendSyncFailureAlert).toHaveBeenCalledTimes(1);
    const itArg = (sendSyncFailureAlert as jest.Mock).mock.calls[0][0];
    expect(itArg.failures.map((f: any) => [f.op, f.target])).toEqual([["invite", "broken@x.com"]]);
  });

  it("routes team-update and delete failures to the IT alert with their op and target", async () => {
    mockGroups({
      G1: [{ id: "1", displayName: "Keep", mail: "keep@x.com", accountEnabled: true }],
      GV: [],
    });
    hmock.onGet("/agents").reply(200, [
      // keep@x.com needs T1 added -> update; gone@x.com is undesired with only T1 -> delete.
      { ID: "a-keep", email: "keep@x.com", roles: ["normal"], teamIDs: [], status: "active" },
      { ID: "a-gone", email: "gone@x.com", roles: ["normal"], teamIDs: ["T1"], status: "active" },
    ]);
    hmock.onPatch(/\/agents\/.+/).reply(500, { error: { type: "server", message: "boom" } });
    hmock.onDelete(/\/agents\/.+/).reply(503);

    await expect(runTeamSync(graph, helpdesk, opts)).rejects.toThrow(/2 change\(s\)/);

    expect(sendSeatLimitAlert).not.toHaveBeenCalled();
    expect(sendSyncFailureAlert).toHaveBeenCalledTimes(1);
    const arg = (sendSyncFailureAlert as jest.Mock).mock.calls[0][0];
    expect(arg.failures.map((f: any) => [f.op, f.target]).sort()).toEqual([
      ["delete", "gone@x.com"],
      ["team-update", "keep@x.com"],
    ]);
  });

  it("a failing alert never changes the sync's own outcome", async () => {
    (sendSeatLimitAlert as jest.Mock).mockRejectedValueOnce(new Error("storage down"));
    (sendSyncFailureAlert as jest.Mock).mockRejectedValueOnce(new Error("storage down"));
    mockGroups({
      G1: [
        { id: "1", displayName: "New", mail: "new@x.com", accountEnabled: true },
        { id: "2", displayName: "Broken", mail: "broken@x.com", accountEnabled: true },
      ],
      GV: [],
    });
    hmock.onGet("/agents").reply(200, []);
    hmock
      .onPost("/agents")
      .replyOnce(409, SEAT_409)
      .onPost("/agents")
      .replyOnce(422, { error: { type: "validation", message: "Validation error" } });

    // Still the invite-failure error, not either alert's.
    await expect(runTeamSync(graph, helpdesk, opts)).rejects.toThrow(/2 change\(s\)/);
    expect(sendSeatLimitAlert).toHaveBeenCalledTimes(1);
    expect(sendSyncFailureAlert).toHaveBeenCalledTimes(1);
  });

  it("suppresses removals when a team group reads empty (no delete despite a stale agent)", async () => {
    mockGroups({ G1: [], GV: [] }); // empty reads
    hmock.onGet("/agents").reply(200, [
      { ID: "a1", email: "x@x.com", roles: ["normal"], teamIDs: ["T1"], status: "active" },
    ]);

    const res = await runTeamSync(graph, helpdesk, opts);
    expect(res.deleted).toBe(0);
    expect(hmock.history.delete).toHaveLength(0);
  });

  it("dry run applies nothing but reports the plan", async () => {
    mockGroups({ G1: [{ id: "2", displayName: "New", mail: "new@x.com", accountEnabled: true }], GV: [] });
    hmock.onGet("/agents").reply(200, []);

    const res = await runTeamSync(graph, helpdesk, { ...opts, dryRun: true });
    expect(res.applied).toBe(false);
    expect(hmock.history.post).toHaveLength(0);
  });

  it("throws when a group read fails (and suppresses that team's removals)", async () => {
    gmock.onGet(/\/groups\/G1\/transitiveMembers/).reply(500);
    gmock.onGet(/\/groups\/GV\/transitiveMembers/).reply(200, { value: [] });
    hmock.onGet("/agents").reply(200, [
      { ID: "a1", email: "x@x.com", roles: ["normal"], teamIDs: ["T1"], status: "active" },
    ]);

    await expect(runTeamSync(graph, helpdesk, opts)).rejects.toThrow(/group read/i);
    expect(hmock.history.delete).toHaveLength(0); // removal suppressed by the failure
    // A failed group read is an IT problem (Graph permissions, deleted group…) — it alerts too.
    expect(sendSyncFailureAlert).toHaveBeenCalledTimes(1);
    const arg = (sendSyncFailureAlert as jest.Mock).mock.calls[0][0];
    expect(arg.failures[0]).toMatchObject({ op: "group-read", target: "G1" });
  });

  it("reaps a pre-existing orphan (no group, zero teams) when all group reads succeed", async () => {
    mockGroups({
      G1: [{ id: "1", displayName: "Keep", mail: "keep@x.com", accountEnabled: true }],
      GV: [],
    });
    hmock.onGet("/agents").reply(200, [
      { ID: "a-keep", email: "keep@x.com", roles: ["normal"], teamIDs: ["T1"], status: "active" },
      { ID: "a-ghost", email: "ghost@x.com", roles: ["normal"], teamIDs: [], status: "active" },
    ]);
    hmock.onDelete("/agents/a-ghost").reply(200, "OK");

    const res = await runTeamSync(graph, helpdesk, { ...opts, cleanupOrphans: true });
    expect(res.deleted).toBe(1);
    expect(hmock.history.delete[0].url).toBe("/agents/a-ghost");
  });

  it("suppresses orphan cleanup when a group read failed (and still throws)", async () => {
    gmock.onGet(/\/groups\/G1\/transitiveMembers/).reply(500);
    gmock.onGet(/\/groups\/GV\/transitiveMembers/).reply(200, { value: [] });
    hmock.onGet("/agents").reply(200, [
      { ID: "a-ghost", email: "ghost@x.com", roles: ["normal"], teamIDs: [], status: "active" },
    ]);

    await expect(runTeamSync(graph, helpdesk, { ...opts, cleanupOrphans: true })).rejects.toThrow(
      /group read/i
    );
    expect(hmock.history.delete).toHaveLength(0); // orphan not reaped on incomplete data
  });

  it("does not delete a protected agent even when fully orphaned", async () => {
    mockGroups({ G1: [], GV: [] });
    hmock.onGet("/agents").reply(200, [
      { ID: "a-own", email: "owner@x.com", roles: ["owner"], teamIDs: [], status: "active" },
    ]);

    const res = await runTeamSync(graph, helpdesk, {
      ...opts,
      cleanupOrphans: true,
      protectedEmails: new Set(["owner@x.com"]),
    });
    expect(res.deleted).toBe(0);
    expect(hmock.history.delete).toHaveLength(0);
  });
});
