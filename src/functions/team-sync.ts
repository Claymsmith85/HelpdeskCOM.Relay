// src/functions/team-sync.ts
// AAD security group -> Helpdesk team/role sync (logic + orchestration; NO function registration, so
// it is freely importable + unit-testable — the thin timer lives in sync-teams.ts, mirroring the
// subscriptions.ts / renew-subscriptions.ts split).
//
// Model: Helpdesk team membership lives as a `teamIDs` array on each agent, plus a `roles` array
// (see helpdesk-client.ts). Config is a list of group RULES — `{ group, team?, role }` — mapping an
// AAD security group (by object ID) to a Helpdesk team and a role. A rule may omit `team` (e.g. a
// "Viewers" group that grants the viewer role but no team). Each desired member accumulates the
// union of roles + teams across the groups they belong to.
//
// Agreed semantics:
//   - New desired member with no agent  -> INVITE a new agent with their role(s) + mapped team(s).
//   - Member added to a mapped group    -> add that group's team to the agent's teamIDs.
//   - Member left a mapped group        -> remove that team; if removing the last MAPPED team leaves
//                                          the agent with zero teams AND they're no longer desired
//                                          anywhere, DELETE the agent (frees the license).
//   - Scope = "mapped teams only": only teams that appear in a rule are ever added/removed; an
//     agent's other (manually-assigned) teams are never touched.
//   - Team-less groups (Viewers) are EXISTENCE/ADD-ONLY: they invite missing members but never drive
//     a delete — deletion is strictly tied to losing the last mapped TEAM. So a member who is still
//     desired (e.g. a viewer) is never deleted.
//   - Safety: a group that reads EMPTY (or whose read failed) has its team's removals suppressed
//     (can't tell a legit-empty group from a bad read). Total removals across the run are capped
//     (TEAM_SYNC_MAX_REMOVALS); over the cap, ALL removals/deletes are dropped this run while adds
//     still apply.
import { AxiosInstance } from "axios";
import {
  HelpdeskAgent,
  inviteAgent,
  listAgents,
  updateAgentTeams,
  deleteAgent,
} from "./helpdesk-client";
import { listGroupMemberUsers } from "./graph-directory";
import { formatAxiosError } from "./logging";
import { envPositiveNumber } from "./env";
import { GroupRule, managementTeamForEnvironment, rulesForEnvironment } from "./team-mapping";
import {
  SeatAlertOutcome,
  SeatLimitInfo,
  seatLimitFromError,
  sendSeatLimitAlert,
} from "./seat-alert";

// #region Config

export type TeamSyncOptions = {
  rules: GroupRule[]; // group->team/role mapping (hardcoded in team-mapping.ts)
  maxRemovals: number;
  defaultRole: string; // role used when a rule omits one
  dryRun: boolean;
  cleanupOrphans: boolean; // also reap PRE-EXISTING agents in no mapped group with zero teams
  protectedEmails: Set<string>; // emails (lowercased) never deleted — owner / break-glass admins
  // Helpdesk team mailed when an invite is rejected for want of an agent license (seat-alert.ts).
  // Undefined (e.g. Development) => the condition is logged but no mail is sent.
  managementTeamId?: string;
  // RELAY_ENVIRONMENT, carried through for the alert's daily-claim key and its body.
  environment?: string;
};

/**
 * Parse a comma-separated email list into a lowercased Set — the never-delete allowlist.
 */
export function parseEmailSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Build the sync options: the hardcoded group rules (team-mapping.ts) plus tunables from the
 * environment.
 */
export function teamSyncOptionsFromEnv(): TeamSyncOptions {
  return {
    rules: rulesForEnvironment(process.env.RELAY_ENVIRONMENT),
    maxRemovals: envPositiveNumber(process.env.TEAM_SYNC_MAX_REMOVALS, 5, { integer: true }),
    defaultRole: (process.env.TEAM_SYNC_DEFAULT_ROLE ?? "normal").trim() || "normal",
    dryRun: (process.env.TEAM_SYNC_DRY_RUN ?? "").trim().toLowerCase() === "true",
    managementTeamId: managementTeamForEnvironment(process.env.RELAY_ENVIRONMENT),
    environment: process.env.RELAY_ENVIRONMENT,
    // Default ON: decommission fully-orphaned agents (in no mapped group AND zero teams). Set
    // TEAM_SYNC_CLEANUP_ORPHANS=false to fall back to only deleting agents whose last mapped team
    // was removed this run.
    cleanupOrphans: (process.env.TEAM_SYNC_CLEANUP_ORPHANS ?? "true").trim().toLowerCase() !== "false",
    protectedEmails: parseEmailSet(process.env.TEAM_SYNC_PROTECTED_AGENTS),
  };
}

// Privilege ordering for collapsing a member's union of roles (across their groups) into the single
// most-privileged role to invite them with. Unknown roles rank 0 (a known role wins).
const ROLE_RANK: Record<string, number> = { owner: 3, normal: 2, viewer: 1 };

/**
 * Pick the most-privileged role from a set (owner > normal > viewer). Falls back to `fallback`.
 */
export function bestRole(roles: Iterable<string>, fallback: string): string {
  let best: string | undefined;
  let bestRank = -1;
  for (const r of roles) {
    const rank = ROLE_RANK[r] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = r;
    }
  }
  return best ?? fallback;
}

// #endregion

// #region Plan (pure)

// What AAD says SHOULD be true for one agent: the union of roles + mapped teams across their groups.
export type DesiredAgent = {
  email: string;
  name: string;
  roles: Set<string>;
  teams: Set<string>;
};

export type DesiredState = {
  agents: Map<string, DesiredAgent>; // by lowercased email
  suppressedTeams: Set<string>; // teams whose group read was empty/failed -> removals suppressed
};

export type AgentInvite = { email: string; name: string; roles: string[]; teamIDs: string[] };
export type AgentTeamUpdate = {
  agentId: string;
  email: string;
  teamIDs: string[]; // the new full list to PATCH (mapped changes applied, non-mapped preserved)
  added: string[];
  removed: string[];
};
export type AgentDelete = { agentId: string; email: string };

export type SyncPlan = {
  invites: AgentInvite[];
  updates: AgentTeamUpdate[];
  deletes: AgentDelete[];
  plannedRemovals: number; // total mapped-team removals computed BEFORE the cap decision
  removalsCapped: boolean; // true => removals exceeded the cap and were all dropped this run
};

const normEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();

/**
 * Pure reconciler: given desired (AAD) + current (Helpdesk) state, compute the change set.
 * Touches ONLY teams in `mappedTeamIds`; never removes a team in `desired.suppressedTeams`.
 *
 * Decommission (DELETE) rule: an agent is deleted when, after applying the mapped add/removes, they
 * hold ZERO Helpdesk teams (mapped *and* manual) AND are in NO mapped group — i.e. fully orphaned.
 *   - `opts.cleanupOrphans` on  → also reaps PRE-EXISTING orphans the sync didn't touch this run
 *     (a true up). Off → only deletes agents whose last mapped team was removed THIS run.
 *   - `opts.protectedEmails`    → never deleted; if a change would orphan them they're left entirely
 *     untouched this run (so the sync never strands or removes a break-glass / owner account).
 * Orphan deletes count toward `maxRemovals`; over the cap, ALL removals/deletes are dropped this run
 * (adds still apply).
 */
export function planTeamSync(
  desired: DesiredState,
  agents: HelpdeskAgent[],
  mappedTeamIds: Set<string>,
  maxRemovals: number,
  fallbackRole: string,
  opts: { cleanupOrphans?: boolean; protectedEmails?: Set<string> } = {}
): SyncPlan {
  const cleanupOrphans = opts.cleanupOrphans ?? false;
  const protectedEmails = opts.protectedEmails ?? new Set<string>();

  const agentByEmail = new Map<string, HelpdeskAgent>();
  for (const a of agents) {
    const key = normEmail(a.email);
    if (key) agentByEmail.set(key, a);
  }

  // Pass 1: per agent, compute the mapped add/remove, the resulting team list, and the intended kind
  // — tallying destructive ops for the cap BEFORE anything is applied.
  type Intent = {
    agent: HelpdeskAgent;
    email: string;
    toAdd: string[];
    toRemove: string[];
    newTeamIDs: string[];
    kind: "update" | "delete";
  };
  const intents: Intent[] = [];
  let plannedRemovals = 0;

  for (const agent of agents) {
    const email = normEmail(agent.email);
    const want = email ? desired.agents.get(email) : undefined;
    const wantTeams = want?.teams ?? new Set<string>();
    const current = new Set(agent.teamIDs ?? []);

    const toAdd: string[] = [];
    const toRemove: string[] = [];
    for (const teamId of mappedTeamIds) {
      const wants = wantTeams.has(teamId);
      const has = current.has(teamId);
      if (wants && !has) toAdd.push(teamId);
      if (!wants && has && !desired.suppressedTeams.has(teamId)) toRemove.push(teamId);
    }

    const next = new Set(current);
    for (const t of toRemove) next.delete(t);
    for (const t of toAdd) next.add(t);
    const newTeamIDs = [...next];

    // Fully orphaned: zero teams remaining AND in no mapped group.
    const orphaned = newTeamIDs.length === 0 && !want;

    if (orphaned) {
      if (protectedEmails.has(email)) {
        // Protected: never delete — and don't even apply the emptying removal. Hands off.
        continue;
      }
      if (toRemove.length > 0) {
        // Lost their last mapped team this run -> decommission.
        plannedRemovals += toRemove.length;
        intents.push({ agent, email, toAdd, toRemove, newTeamIDs, kind: "delete" });
      } else if (cleanupOrphans) {
        // Pre-existing orphan (already zero teams, in no group) -> true cleanup.
        plannedRemovals += 1; // count the destructive op toward the cap
        intents.push({ agent, email, toAdd, toRemove, newTeamIDs, kind: "delete" });
      }
      // else: conservative -> leave the pre-existing orphan alone.
      continue;
    }

    if (toAdd.length || toRemove.length) {
      plannedRemovals += toRemove.length;
      intents.push({ agent, email, toAdd, toRemove, newTeamIDs, kind: "update" });
    }
  }

  // Safety cap: if destructive ops exceed the cap, drop ALL removals/deletes this run (adds still
  // apply, as adds-only updates).
  const removalsCapped = plannedRemovals > maxRemovals;

  const updates: AgentTeamUpdate[] = [];
  const deletes: AgentDelete[] = [];

  for (const it of intents) {
    if (removalsCapped) {
      // Keep only the adds (no removals, no deletes) this run.
      if (it.toAdd.length) {
        const next = new Set(it.agent.teamIDs ?? []);
        for (const t of it.toAdd) next.add(t);
        updates.push({ agentId: it.agent.ID, email: it.email, teamIDs: [...next], added: it.toAdd, removed: [] });
      }
      continue;
    }
    if (it.kind === "delete") {
      deletes.push({ agentId: it.agent.ID, email: it.email });
    } else {
      updates.push({
        agentId: it.agent.ID,
        email: it.email,
        teamIDs: it.newTeamIDs,
        added: it.toAdd,
        removed: it.toRemove,
      });
    }
  }

  // Pass 2: desired members with no existing agent -> invite with their role(s) + mapped team(s).
  const invites: AgentInvite[] = [];
  for (const [email, want] of desired.agents) {
    if (!email || agentByEmail.has(email)) continue;
    invites.push({
      email,
      name: want.name || email,
      roles: [bestRole(want.roles, fallbackRole)],
      teamIDs: [...want.teams],
    });
  }

  return { invites, updates, deletes, plannedRemovals, removalsCapped };
}

// #endregion

// #region Orchestration

export type TeamSyncSummary = {
  skipped: boolean; // no rules configured
  applied: boolean; // false on dry run
  invited: number;
  updated: number;
  deleted: number;
  plannedRemovals: number;
  removalsCapped: boolean;
  groupReadFailures: number;
  failed: number; // apply failures (isolated per item)
  // Read-side visibility, so a run's log shows what we WANTED (not just what changed): how many
  // groups were read, how many came back empty, how many distinct agents AAD resolved to, and how
  // many agents Helpdesk already had. `desiredAgents === 0` across a non-zero `groupsConfigured` is
  // the tell-tale of a permissions/identity fault — the wrapper flags it at ERROR.
  groupsConfigured: number;
  groupsEmpty: number;
  desiredAgents: number;
  existingAgents: number;
  // True when at least one invite was rejected because Helpdesk has no agent licenses left. This is
  // a *business* condition (buy seats), not a code fault — hence its own flag rather than just
  // `failed > 0`. `seatAlert` records what the once-daily Management alert did about it.
  seatLimited: boolean;
  seatAlert?: SeatAlertOutcome;
};

/**
 * Run one full sync: read desired (AAD) + current (Helpdesk) state, plan, and apply.
 * Per-group and per-item isolated; throws at the end if any group read or any apply failed (so the
 * timer invocation is marked failed and alertable) — but only after every item was attempted.
 * `removalsCapped` is surfaced in the summary for the caller to log at ERROR severity.
 */
export async function runTeamSync(
  graph: AxiosInstance,
  helpdesk: AxiosInstance,
  opts: TeamSyncOptions,
  log?: (...args: any[]) => void
): Promise<TeamSyncSummary> {
  const base: TeamSyncSummary = {
    skipped: false,
    applied: !opts.dryRun,
    invited: 0,
    updated: 0,
    deleted: 0,
    plannedRemovals: 0,
    removalsCapped: false,
    groupReadFailures: 0,
    failed: 0,
    groupsConfigured: 0,
    groupsEmpty: 0,
    desiredAgents: 0,
    existingAgents: 0,
    seatLimited: false,
  };

  const rules = opts.rules;
  if (rules.length === 0) {
    log?.("Team sync: no group rules configured (team-mapping.ts); nothing to do");
    return { ...base, skipped: true, applied: false };
  }
  const mappedTeamIds = new Set(rules.map((r) => r.team).filter((t): t is string => !!t));
  const groupsConfigured = rules.length;

  // ---- Desired state from AAD (per-group isolated) ----
  const desired: DesiredState = { agents: new Map(), suppressedTeams: new Set() };
  let groupReadFailures = 0;
  let groupsEmpty = 0; // reads that returned zero members (an empty group OR a silent bad read)

  const upsert = (email: string, name: string): DesiredAgent => {
    let d = desired.agents.get(email);
    if (!d) {
      d = { email, name, roles: new Set(), teams: new Set() };
      desired.agents.set(email, d);
    } else if (!d.name && name) {
      d.name = name;
    }
    return d;
  };

  for (const rule of rules) {
    const role = rule.role ?? opts.defaultRole;
    try {
      const members = await listGroupMemberUsers(graph, rule.group, log);
      if (members.length === 0) groupsEmpty++;
      if (rule.team && members.length === 0) {
        // Can't distinguish a legit-empty group from a bad/partial read -> suppress this team's
        // removals so we never mass-deprovision off an empty result.
        desired.suppressedTeams.add(rule.team);
        log?.("Team sync: group read empty -> suppressing removals for team", {
          group: rule.group,
          team: rule.team,
        });
      }
      for (const m of members) {
        if (!m.accountEnabled) continue; // disabled AAD account -> not a desired active agent
        const d = upsert(m.email, m.name);
        d.roles.add(role);
        if (rule.team) d.teams.add(rule.team);
      }
    } catch (e) {
      groupReadFailures++;
      if (rule.team) desired.suppressedTeams.add(rule.team);
      log?.("Team sync: group read FAILED -> suppressing removals for team", {
        group: rule.group,
        team: rule.team,
        error: formatAxiosError(e),
      });
    }
  }

  // One consolidated line for "what AAD resolved to" — easier to scan than the N per-group lines
  // above, and the fields a run's health check keys on (all-empty => almost certainly a bad read).
  log?.("Team sync: desired state resolved from AAD", {
    groupsConfigured,
    groupsEmpty,
    groupReadFailures,
    desiredAgents: desired.agents.size,
    suppressedTeams: desired.suppressedTeams.size,
  });

  // ---- Current Helpdesk agents + plan ----
  // Only reap PRE-EXISTING orphans when EVERY group read succeeded — a failed read means we can't
  // trust "in no group", so we don't decommission off incomplete data.
  const cleanupOrphans = opts.cleanupOrphans && groupReadFailures === 0;
  if (opts.cleanupOrphans && !cleanupOrphans) {
    log?.("Team sync: orphan cleanup suppressed this run (a group read failed)");
  }
  const agents = await listAgents(helpdesk);
  const plan = planTeamSync(desired, agents, mappedTeamIds, opts.maxRemovals, opts.defaultRole, {
    cleanupOrphans,
    protectedEmails: opts.protectedEmails,
  });

  log?.("Team sync plan", {
    invites: plan.invites.length,
    updates: plan.updates.length,
    deletes: plan.deletes.length,
    plannedRemovals: plan.plannedRemovals,
    removalsCapped: plan.removalsCapped,
    dryRun: opts.dryRun,
  });
  if (plan.removalsCapped) {
    log?.(
      `Team sync: planned removals (${plan.plannedRemovals}) exceeded cap (${opts.maxRemovals}) — ` +
        "ALL removals/deletes skipped this run; adds still applied"
    );
  }

  const summary: TeamSyncSummary = {
    ...base,
    plannedRemovals: plan.plannedRemovals,
    removalsCapped: plan.removalsCapped,
    groupReadFailures,
    groupsConfigured,
    groupsEmpty,
    desiredAgents: desired.agents.size,
    existingAgents: agents.length,
  };

  if (opts.dryRun) {
    log?.("Team sync: DRY RUN — no changes applied", {
      invites: plan.invites.map((i) => ({ email: i.email, roles: i.roles, teamIDs: i.teamIDs })),
      updates: plan.updates.map((u) => ({ email: u.email, added: u.added, removed: u.removed })),
      deletes: plan.deletes.map((d) => d.email),
    });
    if (groupReadFailures > 0) {
      throw new Error(`runTeamSync (dry run): ${groupReadFailures} group read(s) failed`);
    }
    return summary;
  }

  // ---- Apply (per-item isolated) ----
  let failed = 0;
  // Invites Helpdesk refused for want of an agent license, batched so the whole day's shortfall is
  // one email rather than one per blocked user.
  const seatBlocked: { email: string; name?: string }[] = [];
  let seatLimit: SeatLimitInfo | null = null;

  for (const inv of plan.invites) {
    try {
      const id = await inviteAgent({
        helpdesk,
        email: inv.email,
        name: inv.name,
        roles: inv.roles,
        teamIDs: inv.teamIDs,
      });
      summary.invited++;
      log?.("Team sync: agent invited", {
        email: inv.email,
        agentId: id,
        roles: inv.roles,
        teamIDs: inv.teamIDs,
      });
    } catch (e) {
      failed++;
      // Log what we SENT alongside the rejection: a 4xx from POST /agents is a semantic rejection
      // (e.g. the email already exists, or a seat limit), so the payload is half the diagnosis.
      log?.("Team sync: invite FAILED", {
        email: inv.email,
        roles: inv.roles,
        teamIDs: inv.teamIDs,
        error: formatAxiosError(e),
      });
      // "Out of agent licenses" is the one invite failure a human must act on. Collect it here and
      // alert once, after every invite has been attempted, so one mail names all blocked users.
      const seat = seatLimitFromError(e);
      if (seat) {
        seatLimit = seat;
        seatBlocked.push({ email: inv.email, name: inv.name });
      }
    }
  }

  for (const up of plan.updates) {
    try {
      await updateAgentTeams(helpdesk, up.agentId, up.teamIDs);
      summary.updated++;
      log?.("Team sync: agent teams updated", {
        email: up.email,
        added: up.added,
        removed: up.removed,
      });
    } catch (e) {
      failed++;
      log?.("Team sync: team update FAILED", { email: up.email, error: formatAxiosError(e) });
    }
  }

  for (const del of plan.deletes) {
    try {
      await deleteAgent(helpdesk, del.agentId);
      summary.deleted++;
      log?.("Team sync: agent deleted (no mapped teams remaining)", {
        email: del.email,
        agentId: del.agentId,
      });
    } catch (e) {
      failed++;
      log?.("Team sync: delete FAILED", { email: del.email, error: formatAxiosError(e) });
    }
  }

  // Best-effort by contract: the seat-limit alert must not change the sync's outcome. A failure to
  // mail is logged and swallowed — the invite failures below still fail the run, as they should.
  if (seatLimit) {
    summary.seatLimited = true;
    try {
      summary.seatAlert = await sendSeatLimitAlert({
        graph,
        agents,
        managementTeamId: opts.managementTeamId,
        blocked: seatBlocked,
        info: seatLimit,
        environment: opts.environment,
        log,
      });
    } catch (e) {
      log?.("Team sync: seat-limit alert FAILED", { error: formatAxiosError(e) });
    }
  }

  summary.failed = failed;
  log?.("Team sync done", summary);
  if (failed > 0 || groupReadFailures > 0) {
    throw new Error(
      `runTeamSync: ${failed} change(s) and ${groupReadFailures} group read(s) failed`
    );
  }
  return summary;
}

// #endregion
