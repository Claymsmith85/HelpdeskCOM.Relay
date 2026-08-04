// src/functions/sync-change-alert.ts
// The "team sync changed something" alert — a CHANGES-category definition on top of the generic
// alert engine (alerts.ts, which owns routing, the once-daily throttle, and sending).
//
// WHY THIS EXISTS. The hourly sync silently reshapes the Helpdesk agent roster from AAD group
// membership: it invites agents, moves them between teams, and deletes fully-orphaned ones (which
// frees a paid seat). All of that lands only in Application Insights traces nobody watches, so an
// unexpected group edit (or a mapping mistake in team-mapping.ts) can reprovision people with no
// human the wiser. This mails a digest of the changes a run ACTUALLY APPLIED — successful
// invites/updates/deletes only; failures are the other two alerts' job (sync-failure-alert.ts,
// seat-alert.ts), and a dry run applies nothing so it never alerts.
//
// ROUTING: the `changes` category — Development / IT Support (both environments, they own the AAD
// groups) plus the Mgmt. Team (Production only, seat-usage visibility). See ALERT_TEAMS_BY_ENV.
//
// THROTTLE KEY: the stable "team-changes" — at most ONE mail per environment per Eastern day (the
// seat-alert convention, chosen deliberately over the sync-failure signature-key convention).
// Changes applied later the same day are visible in the sync-teams traces but not emailed.
import { AxiosInstance } from "axios";
import { HelpdeskAgent } from "./helpdesk-client";
import { AlertOutcome, sendAlert } from "./alerts";

// The changes one run successfully applied. Shapes mirror team-sync.ts's plan types, but are
// declared here (like sync-failure-alert's SyncFailure) so team-sync.ts can import this module
// without a cycle.
export type AppliedInvite = { email: string; name?: string; roles: string[]; teamIDs: string[] };
export type AppliedTeamUpdate = { email: string; added: string[]; removed: string[] };
export type AppliedDelete = { email: string };

export type AppliedChanges = {
  invited: AppliedInvite[];
  updated: AppliedTeamUpdate[];
  deleted: AppliedDelete[];
};

export function hasAppliedChanges(c: AppliedChanges): boolean {
  return c.invited.length + c.updated.length + c.deleted.length > 0;
}

export function changeAlertSubject(c: AppliedChanges, environment: string | undefined): string {
  const parts: string[] = [];
  if (c.invited.length) parts.push(`${c.invited.length} added`);
  if (c.deleted.length) parts.push(`${c.deleted.length} removed`);
  if (c.updated.length)
    parts.push(`${c.updated.length} team change${c.updated.length === 1 ? "" : "s"}`);
  return `Helpdesk relay: agent/team changes applied (${parts.join(", ")}) — ${environment ?? "unknown"}`;
}

/**
 * Body content only — the engine appends the environment/automation footer. `teamNames` maps
 * Helpdesk team IDs to display names for readability; a missing entry (or no map at all — the
 * lookup is best-effort) falls back to the raw ID, which is still actionable.
 */
export function changeAlertBody(
  c: AppliedChanges,
  teamNames?: Record<string, string>
): string {
  const team = (id: string) => teamNames?.[id] ?? id;
  const teams = (ids: string[]) => ids.map(team).join(", ");

  const lines = [
    "The automated AAD -> Helpdesk team sync applied the following change(s) on its last run:",
  ];

  if (c.invited.length) {
    lines.push("", `Agents added (${c.invited.length}):`);
    for (const i of c.invited) {
      const who = i.name && i.name !== i.email ? `${i.name} <${i.email}>` : i.email;
      const to = i.teamIDs.length ? `; teams: ${teams(i.teamIDs)}` : "";
      lines.push(`  - ${who} — role ${i.roles.join(", ")}${to}`);
    }
  }
  if (c.updated.length) {
    lines.push("", `Team membership changes (${c.updated.length}):`);
    for (const u of c.updated) {
      const bits = [
        u.added.length ? `added to ${teams(u.added)}` : "",
        u.removed.length ? `removed from ${teams(u.removed)}` : "",
      ].filter(Boolean);
      lines.push(`  - ${u.email} — ${bits.join("; ")}`);
    }
  }
  if (c.deleted.length) {
    lines.push("", `Agents removed (${c.deleted.length}):`);
    for (const d of c.deleted) {
      lines.push(`  - ${d.email} (no mapped AAD group and no Helpdesk teams remaining; seat freed)`);
    }
  }

  lines.push(
    "",
    "These changes are driven by AAD security-group membership. If one is unexpected, review the",
    "group's members in Azure AD (and the group->team mapping in the relay's team-mapping.ts).",
    "This alert is sent at most once per day; any further changes today are recorded in",
    "Application Insights only (traces from the sync-teams function)."
  );
  return lines.join("\n");
}

export type SyncChangeAlertOptions = {
  graph: AxiosInstance;
  /** The agent list runTeamSync already fetched — recipients are the routed teams' members. */
  agents: HelpdeskAgent[];
  changes: AppliedChanges;
  /** Best-effort Helpdesk team ID -> name map for the body; omit to render raw IDs. */
  teamNames?: Record<string, string>;
  environment?: string;
  fromMailbox?: string;
  log?: (...args: any[]) => void;
  // --- test seams (production omits both) ---
  client?: AxiosInstance;
  now?: () => Date;
};

/**
 * Mail a digest of the changes a sync run applied — at most once per environment per Eastern day.
 * Best-effort by contract: the caller (runTeamSync) must not let a failure here change the sync's
 * own outcome.
 */
export async function sendSyncChangeAlert(opts: SyncChangeAlertOptions): Promise<AlertOutcome> {
  const { changes } = opts;
  return sendAlert({
    category: "changes",
    key: "team-changes",
    subject: changeAlertSubject(changes, opts.environment),
    body: changeAlertBody(changes, opts.teamNames),
    detail: {
      invited: changes.invited.map((i) => i.email),
      updated: changes.updated.map((u) => ({ email: u.email, added: u.added, removed: u.removed })),
      deleted: changes.deleted.map((d) => d.email),
    },
    graph: opts.graph,
    agents: opts.agents,
    environment: opts.environment,
    fromMailbox: opts.fromMailbox,
    log: opts.log,
    client: opts.client,
    now: opts.now,
  });
}
