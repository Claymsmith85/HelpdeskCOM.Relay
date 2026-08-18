// Tests for reply-mailbox.ts — which shared mailbox outbound webhook mail is sent AS. Pure helpers
// (routing.ts + env only), so no @azure/functions mock is needed.

import {
  DEFAULT_REPLY_MAILBOX,
  assignedTeamIdForEvent,
  resolveReplyMailbox,
} from "./reply-mailbox";

const TEAM_ESCAPE = "3db812da-2055-436f-9889-7073b5e976f4";
const TEAM_REFERRALS = "3a5e9d73-e5a0-442e-888b-6573672c9d05";
const TEAM_ENDORSEMENTS = "c4e7bc52-0c7a-43fb-aa46-0d69f533ee2b";
const TEAM_DEV = "61ed7601-b6e3-43c2-936a-7afe45e4e246";
const TEAM_MGMT = "4533d6c2-98fc-4563-855a-c5205f4c856d"; // real team, owns no mailbox

const MB_ESCAPE = "escape@corespecialty.com";
const MB_REFERRALS = "escapereferrals@corespecialty.com";
const MB_ENDORSEMENTS = "escapeendorsements@corespecialty.com";

/** A webhook payload with just the fields the resolution reads. */
function payload(over: {
  inbox?: string | null;
  team?: string | null;
  teamIDs?: unknown[];
  events?: unknown[];
} = {}) {
  const { inbox = MB_ESCAPE, team, teamIDs, events } = over;
  return {
    payload: {
      customFields: inbox === null ? {} : { email: "jane@example.com", inbox },
      ...(team === undefined
        ? {}
        : { assignment: team === null ? null : { team: { ID: team, name: "T" } } }),
      ...(teamIDs ? { teamIDs } : {}),
      ...(events ? { events } : {}),
    },
  } as any;
}

const assignmentEvent = (teamId: string, over: Record<string, unknown> = {}) => ({
  ID: 42,
  assignment: { new: { team: { ID: teamId, name: "T" }, agent: { ID: "a1", name: "A" } }, old: { team: { ID: TEAM_ESCAPE, name: "Escape" } } },
  ...over,
});

afterEach(() => {
  delete process.env.MAILBOX_ADDRESSES;
  delete process.env.RELAY_IN_SCOPE_DOMAINS;
});

describe("assignedTeamIdForEvent", () => {
  it("prefers the payload's assignment snapshot (the state at the time of this delivery)", () => {
    expect(
      assignedTeamIdForEvent(payload({ team: TEAM_REFERRALS, events: [assignmentEvent(TEAM_ENDORSEMENTS)] }))
    ).toBe(TEAM_REFERRALS);
  });

  it("falls back to the most recent assignment event when the snapshot is missing", () => {
    expect(
      assignedTeamIdForEvent(
        payload({ events: [assignmentEvent(TEAM_ESCAPE), { message: { text: "hi" } }, assignmentEvent(TEAM_ENDORSEMENTS)] })
      )
    ).toBe(TEAM_ENDORSEMENTS);
  });

  it("picks up a same-action auto-assignment companion trailing the reply", () => {
    // The reply is the action event, but the assignment it triggered sits after it.
    const events = [
      { ID: 41, message: { text: "Reply while unassigned", isPrivate: false } },
      assignmentEvent(TEAM_REFERRALS, { ID: 42 }),
    ];
    expect(assignedTeamIdForEvent(payload({ team: null, events }))).toBe(TEAM_REFERRALS);
  });

  it("ignores a blank snapshot and blank or malformed event assignments", () => {
    const events = [{ assignment: { new: { team: { ID: "  " } } } }, { assignment: {} }, { message: { text: "x" } }];
    expect(assignedTeamIdForEvent(payload({ team: "   ", events }))).toBeNull();
  });

  it("uses teamIDs only for an entry that owns a mailbox", () => {
    expect(assignedTeamIdForEvent(payload({ team: null, teamIDs: [TEAM_MGMT, TEAM_ENDORSEMENTS] }))).toBe(
      TEAM_ENDORSEMENTS
    );
    expect(assignedTeamIdForEvent(payload({ team: null, teamIDs: [TEAM_MGMT] }))).toBeNull();
  });

  it("is null for a payload with nothing to go on", () => {
    expect(assignedTeamIdForEvent({ payload: {} } as any)).toBeNull();
  });
});

describe("resolveReplyMailbox", () => {
  it("sends as the ASSIGNED team's mailbox, not the inbox the mail originally landed in", () => {
    // The workflow bug this fixes: ticket arrived at escape@, was reassigned to Escape Referrals.
    const res = resolveReplyMailbox(payload({ inbox: MB_ESCAPE, team: TEAM_REFERRALS }));
    expect(res).toEqual({ mailbox: MB_REFERRALS, teamId: TEAM_REFERRALS, source: "team" });
  });

  it("follows a second reassignment", () => {
    expect(resolveReplyMailbox(payload({ inbox: MB_ESCAPE, team: TEAM_ENDORSEMENTS })).mailbox).toBe(
      MB_ENDORSEMENTS
    );
  });

  it("maps the dev/IT team to the dev Escape mailbox", () => {
    expect(resolveReplyMailbox(payload({ inbox: MB_ESCAPE, team: TEAM_DEV })).mailbox).toBe(
      "ureferrals@corespecialty.com"
    );
  });

  it("falls back to the Escape mailbox when the assigned team owns no mailbox — NOT the stale inbox", () => {
    const res = resolveReplyMailbox(payload({ inbox: MB_REFERRALS, team: TEAM_MGMT }));
    expect(res.mailbox).toBe(DEFAULT_REPLY_MAILBOX);
    expect(res.source).toBe("default");
    expect(res.reason).toContain(TEAM_MGMT);
  });

  it("falls back to the Escape mailbox when the ticket has no assigned team", () => {
    const res = resolveReplyMailbox(payload({ inbox: MB_REFERRALS, team: null }));
    expect(res).toEqual({
      mailbox: DEFAULT_REPLY_MAILBOX,
      teamId: null,
      source: "default",
      reason: "ticket has no assigned team",
    });
  });

  it("falls back to the Escape mailbox with neither a team mailbox nor an inbox", () => {
    const res = resolveReplyMailbox(payload({ inbox: null, team: TEAM_MGMT }));
    expect(res.mailbox).toBe(DEFAULT_REPLY_MAILBOX);
    expect(res.source).toBe("default");
  });

  it("does not send as a team mailbox this app is not configured for (Graph would 403)", () => {
    // Dev app, Dev mailbox only: a Production team's ticket must not try to send as escapereferrals@.
    process.env.MAILBOX_ADDRESSES = "ureferrals@corespecialty.com";
    const res = resolveReplyMailbox(payload({ inbox: "ureferrals@corespecialty.com", team: TEAM_REFERRALS }));
    expect(res.mailbox).toBe("ureferrals@corespecialty.com");
    expect(res.source).toBe("inbox");
    expect(res.reason).toContain("MAILBOX_ADDRESSES");
  });

  it("accepts a configured team mailbox spelled on an alias company domain", () => {
    process.env.MAILBOX_ADDRESSES = "escape@corespecialtyins.com,escapereferrals@corespecialtyins.com";
    expect(resolveReplyMailbox(payload({ inbox: MB_ESCAPE, team: TEAM_REFERRALS })).mailbox).toBe(
      MB_REFERRALS
    );
  });

  it("skips the configured-mailbox check when no mailboxes are configured at all", () => {
    expect(resolveReplyMailbox(payload({ inbox: MB_ESCAPE, team: TEAM_REFERRALS })).source).toBe("team");
  });

  it("prefers the Escape default over an unsendable recorded inbox on the safety-valve path", () => {
    // Neither the team's mailbox nor the ticket's recorded inbox is one this app can send as.
    process.env.MAILBOX_ADDRESSES = "ureferrals@corespecialty.com";
    const res = resolveReplyMailbox(payload({ inbox: MB_ENDORSEMENTS, team: TEAM_REFERRALS }));
    expect(res.mailbox).toBe(DEFAULT_REPLY_MAILBOX);
    expect(res.source).toBe("default");
    expect(res.reason).toContain("MAILBOX_ADDRESSES");
  });
});
