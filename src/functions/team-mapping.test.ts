// Guards the hardcoded, per-environment AAD-group -> Helpdesk-team/role tables (team-mapping.ts).
// A typo'd or duplicated GUID, a missing role, or a team-less agent rule would silently
// mis-provision agents, so assert each environment table's structural invariants here — plus the
// safe-default behavior of the environment resolver.
import {
  ALERT_TEAMS_BY_ENV,
  RULES_BY_ENV,
  GroupRule,
  alertTeamForEnvironment,
  rulesForEnvironment,
} from "./team-mapping";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertWellFormed(rules: GroupRule[]) {
  // Unique AAD group per rule.
  const groups = rules.map((r) => r.group);
  expect(new Set(groups).size).toBe(groups.length);

  for (const r of rules) {
    // Valid Helpdesk API role.
    expect(["owner", "normal", "viewer"]).toContain(r.role);
    // owner/normal work tickets and need a team; viewer is role-only (no team).
    if (r.role === "viewer") expect(r.team).toBeUndefined();
    else expect(r.team).toBeTruthy();
    // GUID-shaped IDs.
    expect(r.group).toMatch(GUID);
    if (r.team) expect(r.team).toMatch(GUID);
  }
}

describe("RULES_BY_ENV", () => {
  it("every environment table is well-formed", () => {
    for (const rules of Object.values(RULES_BY_ENV)) {
      assertWellFormed(rules);
    }
  });

  it("Production has rules configured", () => {
    expect(RULES_BY_ENV.Production.length).toBeGreaterThan(0);
  });
});

describe("rulesForEnvironment", () => {
  it("returns the matching environment's table", () => {
    expect(rulesForEnvironment("Production")).toBe(RULES_BY_ENV.Production);
    expect(rulesForEnvironment("Development")).toBe(RULES_BY_ENV.Development);
  });

  it("falls back to Development (never Production) for unset/unknown environments", () => {
    expect(rulesForEnvironment(undefined)).toBe(RULES_BY_ENV.Development);
    expect(rulesForEnvironment("")).toBe(RULES_BY_ENV.Development);
    expect(rulesForEnvironment("Staging")).toBe(RULES_BY_ENV.Development);
  });
});

describe("ALERT_TEAMS_BY_ENV / alertTeamForEnvironment", () => {
  it("every mapped alert team is a GUID, and a team that environment's rules actually map", () => {
    // Recipients are resolved from the agents ON the team — a team outside the sync's own mapping
    // would still work, but a typo'd GUID would silently mail nobody, so pin the cross-reference.
    for (const [env, row] of Object.entries(ALERT_TEAMS_BY_ENV)) {
      const mapped = RULES_BY_ENV[env].map((r) => r.team);
      for (const team of Object.values(row)) {
        if (team === undefined) continue;
        expect(team).toMatch(GUID);
        expect(mapped).toContain(team);
      }
    }
  });

  it("both environments route IT alerts to their Development / IT Support team", () => {
    expect(alertTeamForEnvironment("Production", "it")).toMatch(GUID);
    expect(alertTeamForEnvironment("Development", "it")).toMatch(GUID);
  });

  it("no environment other than Production may mail the licensing (management) team", () => {
    // The licensing alert mails whoever is on this team. Dev shares the Helpdesk account with
    // Prod, so a Dev-mapped licensing team would mail Production's managers from the Dev app.
    expect(alertTeamForEnvironment("Production", "licensing")).toMatch(GUID);
    for (const [env, row] of Object.entries(ALERT_TEAMS_BY_ENV)) {
      if (env !== "Production") expect(row.licensing).toBeUndefined();
    }
  });

  it("an unset/unknown environment falls back to the Development row (never Production's)", () => {
    for (const env of [undefined, "", "Staging"]) {
      expect(alertTeamForEnvironment(env, "licensing")).toBeUndefined();
      expect(alertTeamForEnvironment(env, "it")).toBe(ALERT_TEAMS_BY_ENV.Development.it);
    }
  });
});
