// Tests for the "team sync changed something" alert definition (sync-change-alert.ts): the pure
// subject/body builders (team-name fallback, section omission) and the sendAlert wiring — the
// engine itself (routing, throttle, sending) is alerts.ts's concern and is mocked here.

jest.mock("./alerts", () => ({ sendAlert: jest.fn(async () => "sent") }));

import { sendAlert } from "./alerts";
import {
  AppliedChanges,
  changeAlertBody,
  changeAlertSubject,
  hasAppliedChanges,
  sendSyncChangeAlert,
} from "./sync-change-alert";

const sendMock = sendAlert as jest.Mock;

afterEach(() => jest.clearAllMocks());

const none: AppliedChanges = { invited: [], updated: [], deleted: [] };

const full: AppliedChanges = {
  invited: [
    { email: "alice@corespecialty.com", name: "Alice A", roles: ["normal"], teamIDs: ["t-1"] },
  ],
  updated: [{ email: "bob@corespecialty.com", added: ["t-1"], removed: ["t-2"] }],
  deleted: [{ email: "carol@corespecialty.com" }],
};

describe("hasAppliedChanges", () => {
  it("is false for an empty change set and true when any list is non-empty", () => {
    expect(hasAppliedChanges(none)).toBe(false);
    expect(hasAppliedChanges({ ...none, deleted: [{ email: "x@y.z" }] })).toBe(true);
  });
});

describe("changeAlertSubject", () => {
  it("names only the non-zero change kinds, with counts and the environment", () => {
    expect(changeAlertSubject(full, "Production")).toBe(
      "Helpdesk relay: agent/team changes applied (1 added, 1 removed, 1 team change) — Production"
    );
    expect(changeAlertSubject({ ...none, updated: full.updated.concat(full.updated) }, undefined)).toBe(
      "Helpdesk relay: agent/team changes applied (2 team changes) — unknown"
    );
  });
});

describe("changeAlertBody", () => {
  it("renders team names when the map has them and falls back to raw IDs otherwise", () => {
    const body = changeAlertBody(full, { "t-1": "Escape" });
    expect(body).toContain("Alice A <alice@corespecialty.com> — role normal; teams: Escape");
    expect(body).toContain("bob@corespecialty.com — added to Escape; removed from t-2");
    expect(body).toContain("carol@corespecialty.com (no mapped AAD group");
  });

  it("renders raw IDs when no team-name map is supplied (the lookup is best-effort)", () => {
    expect(changeAlertBody(full)).toContain("added to t-1; removed from t-2");
  });

  it("omits empty sections and always carries the once-per-day note", () => {
    const body = changeAlertBody({ ...none, deleted: [{ email: "x@y.z" }] });
    expect(body).not.toContain("Agents added");
    expect(body).not.toContain("Team membership changes");
    expect(body).toContain("Agents removed (1):");
    expect(body).toContain("at most once per day");
  });
});

describe("sendSyncChangeAlert", () => {
  it("sends through the engine as the `changes` category under the stable daily key", async () => {
    const graph = {} as any;
    const agents = [{ ID: "a1" }] as any;

    const outcome = await sendSyncChangeAlert({
      graph,
      agents,
      changes: full,
      teamNames: { "t-1": "Escape" },
      environment: "Production",
    });

    expect(outcome).toBe("sent");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const opts = sendMock.mock.calls[0][0];
    expect(opts.category).toBe("changes");
    expect(opts.key).toBe("team-changes"); // stable => at most one mail per environment per day
    expect(opts.subject).toContain("agent/team changes applied");
    expect(opts.body).toContain("teams: Escape");
    expect(opts.graph).toBe(graph);
    expect(opts.agents).toBe(agents);
    expect(opts.environment).toBe("Production");
    // The claim blob's forensic detail carries the change set in compact form.
    expect(opts.detail).toEqual({
      invited: ["alice@corespecialty.com"],
      updated: [{ email: "bob@corespecialty.com", added: ["t-1"], removed: ["t-2"] }],
      deleted: ["carol@corespecialty.com"],
    });
  });
});
