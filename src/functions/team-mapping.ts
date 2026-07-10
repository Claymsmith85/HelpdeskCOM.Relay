// src/functions/team-mapping.ts
// Single source of truth for the AAD security-group -> Helpdesk team/role mapping used by the team
// sync (sync-teams / team-sync.ts). Hardcoded in code — like routing.ts's TEAM_BY_INBOX — so the
// mapping (including the privileged `owner` grant) is reviewed in PRs rather than living in a
// deploy/app-setting variable.
//
// PER-ENVIRONMENT: the mapping is keyed by environment so the **Development** function app never
// mutates the **Production** Helpdesk teams. The active environment is selected by the
// `RELAY_ENVIRONMENT` app setting, injected from the deploy matrix ("Production" | "Development";
// see .github/workflows/Deploy.yml). If it is unset/unknown we default to Development — the safe
// (no-op by default) table — so a misconfigured deploy can never run Production's reconcile.
//
// `role` is the Helpdesk API role: `owner` (product "Admin") | `normal` (product "Agent") | `viewer`.
// Omit `team` for a role-only group (e.g. Viewers grants the viewer role with no team assignment).

// One AAD-group -> Helpdesk-team/role rule. `group` is an AAD group **object ID**; `team` is a
// Helpdesk **team ID** (omit for a role-only group); `role` is the Helpdesk API role (defaulted by
// the consumer when omitted).
export type GroupRule = { group: string; team?: string; role?: string };

// Rules per environment. Keys must match the RELAY_ENVIRONMENT values the deploy injects.
export const RULES_BY_ENV: Record<string, GroupRule[]> = {
  Production: [
    // AAD group object ID                              Helpdesk team ID                                role           // team
    { group: "162e426b-c0e4-4fe6-94bb-1079b7ed6723", team: "3db812da-2055-436f-9889-7073b5e976f4", role: "normal" }, // Escape
    { group: "cd290d2a-7da4-4033-96f5-690ee0c5ec90", team: "3a5e9d73-e5a0-442e-888b-6573672c9d05", role: "normal" }, // Escape Referrals
    { group: "ede567f8-dbee-47a3-b27f-e487fadeb0ff", team: "c4e7bc52-0c7a-43fb-aa46-0d69f533ee2b", role: "normal" }, // Escape Endorsements
    { group: "d637982d-0d94-4d22-8065-0d39607ebd50", team: "61ed7601-b6e3-43c2-936a-7afe45e4e246", role: "owner" },  // Development / IT Support
    { group: "f115c151-b108-4dd0-9602-b02fe0bb93b6", team: "4533d6c2-98fc-4563-855a-c5205f4c856d", role: "normal" }, // Mgmt. Team
    { group: "76f8cd79-2030-4f0e-9826-2a0587db5aba", role: "viewer" },                                               // Viewers (role-only, no team)
  ],

  // Development: populate with a dev-only Helpdesk account's teams / test AAD groups. Left EMPTY so
  // the sync is a no-op in Dev by default — the Dev app will not invite/move/delete any agents until
  // real dev rules are added here. (If dev and prod share one Helpdesk account, keeping this empty is
  // the right call so Dev never mutates the live teams.)
  Development: [
    { group: "66cb160a-d65b-4634-a800-fe0c43da4dc8", team: "5a2356e8-8303-49eb-b8ac-838ab7287d8e", role: "normal" },  // Development / IT Support
  ],
};

// The Helpdesk team whose members are emailed when an invite is rejected for want of an agent
// license (see seat-alert.ts). Deliberately keyed off the same per-environment table above: the
// recipients are the agents Helpdesk already has on this team, so the alert reaches the people who
// can buy seats.
//
// `undefined` = no management team mapped for that environment => NO alert mail is sent there (the
// seat-limit condition is still logged at ERROR). Development is intentionally undefined: it has no
// Mgmt. Team rule, and Dev must never mail Production's managers.
export const MANAGEMENT_TEAM_BY_ENV: Record<string, string | undefined> = {
  Production: "4533d6c2-98fc-4563-855a-c5205f4c856d", // Mgmt. Team (see the Production rule above)
  Development: undefined,
};

// Default when RELAY_ENVIRONMENT is unset/unknown. MUST be the least-privileged table (never
// Production), so an unconfigured deploy can't run Production's destructive reconcile.
export const DEFAULT_ENVIRONMENT = "Development";

/**
 * Resolve the active group rules for an environment name (the RELAY_ENVIRONMENT app setting).
 * Falls back to the Development table for an unset/unknown environment.
 */
export function rulesForEnvironment(envName: string | undefined): GroupRule[] {
  const key = (envName ?? "").trim();
  return RULES_BY_ENV[key] ?? RULES_BY_ENV[DEFAULT_ENVIRONMENT] ?? [];
}

/**
 * Resolve the Helpdesk team to notify about exhausted agent licenses. Mirrors
 * `rulesForEnvironment`'s fallback: an unset/unknown environment resolves to the Development table,
 * which has no management team — so an unconfigured deploy sends no alert mail rather than mailing
 * Production's managers.
 */
export function managementTeamForEnvironment(envName: string | undefined): string | undefined {
  const key = (envName ?? "").trim();
  const known = Object.prototype.hasOwnProperty.call(MANAGEMENT_TEAM_BY_ENV, key);
  return known ? MANAGEMENT_TEAM_BY_ENV[key] : MANAGEMENT_TEAM_BY_ENV[DEFAULT_ENVIRONMENT];
}
