// src/functions/sync-teams.ts
// Timer-triggered AAD-security-group -> Helpdesk-team membership sync. Thin wrapper around
// runTeamSync (team-sync.ts holds the logic, mirroring renew-subscriptions.ts / subscriptions.ts).
//
// runOnStartup is OFF: this sync can DELETE agents, so we don't want a surprise reconcile on every
// app restart — it runs on TEAM_SYNC_CRON (default hourly). For the first deploy, set
// TEAM_SYNC_DRY_RUN=true to log the intended changes, then trigger the timer manually to verify
// before enabling for real.
import { app, InvocationContext, Timer } from "@azure/functions";
import { createGraphClientFromEnv } from "./graph-client";
import { createHelpdeskClient } from "./helpdesk-client";
import { runTeamSync, teamSyncOptionsFromEnv } from "./team-sync";
import { createStepLogger } from "./logging";
import { userMgmtEnabled } from "./env";
import { helpdeskGate, publishGate, syncGateFromStore, waitOrDefer } from "./helpdesk-gate";

export async function syncTeams(
  _timer: Timer,
  context: InvocationContext
): Promise<void> {
  const { step, stepWarn, stepError } = createStepLogger(context);
  step("Start: AAD security groups -> Helpdesk teams sync");

  // Master user-management switch (USERMGMT_TOGGLE). When OFF (the default), attempt no user
  // management at all — no agent invite/update/delete. The next enabled run reconciles from live
  // state, so pausing loses nothing.
  if (!userMgmtEnabled()) {
    step("User management disabled (USERMGMT_TOGGLE off) — skipping team sync");
    return;
  }

  await syncGateFromStore(helpdeskGate, (m, d) => step(m, d));
  // Global Helpdesk throttle gate. This sync is the heaviest Helpdesk burst in the codebase — one
  // POST/PATCH/DELETE per agent, unpaced apart from the rate limiter — so it must not start into an
  // active cooldown. A short one is waited out; a long one abandons the run entirely, which costs
  // nothing: the sync is a reconcile against live state, so the next tick picks up exactly where
  // this one would have. Deliberately NOT re-queued (a timer has no queue) and NOT a failure.
  const stillGatedMs = await waitOrDefer();
  if (stillGatedMs > 0) {
    stepWarn("Helpdesk gate: cooldown active; skipping this sync run", { stillGatedMs });
    return;
  }

  try {
    const opts = teamSyncOptionsFromEnv();
    const log = (...a: any[]) => step(String(a[0]), a[1]);

    const graph = await createGraphClientFromEnv(log);
    const helpdesk = createHelpdeskClient({ step, stepWarn, stepError });

    const result = await runTeamSync(graph, helpdesk, opts, log);

    // Every configured group resolved to zero members: the sync did nothing AND is almost certainly
    // misconfigured. A successful-but-empty read is indistinguishable from a genuinely empty group,
    // so a wholesale zero across ALL groups is far more likely a permissions/identity fault
    // (GroupMember.Read.All not effective on the Graph app registration, or the wrong tenant) than
    // reality. Surface it at ERROR so it's alertable — without failing the run (it changed nothing).
    if ((result.groupsConfigured ?? 0) > 0 && result.desiredAgents === 0) {
      stepError(
        "Team sync: resolved 0 members from ALL groups — likely a permissions/identity problem " +
          "(verify GroupMember.Read.All on the Graph app registration and the queried tenant), " +
          "not empty groups",
        new Error("team sync: empty desired state across all configured groups"),
        {
          groupsConfigured: result.groupsConfigured,
          groupsEmpty: result.groupsEmpty,
          groupReadFailures: result.groupReadFailures,
        }
      );
    }

    // The safety cap dropping removals is a notable, alertable condition (a group likely shrank
    // past the threshold or read partially) — surface it at ERROR severity without failing the run,
    // since the adds still applied and removals are simply deferred to a future, in-cap run.
    if (result.removalsCapped) {
      stepError(
        "Team sync: removal cap exceeded — removals skipped this run",
        new Error("TEAM_SYNC_MAX_REMOVALS exceeded"),
        { plannedRemovals: result.plannedRemovals }
      );
    }

    step("Done: team sync complete", result);
  } catch (e) {
    stepError("Team sync failed", e);
    throw e;
  } finally {
    // Hand any cooldown this run opened to the other instances (best-effort), on both paths.
    await publishGate(helpdeskGate, (m, d) => step(m, d));
  }
}

app.timer("sync-teams", {
  // Default hourly. Directory churn is low and this is a reconcile, so sub-hourly buys little.
  schedule: process.env.TEAM_SYNC_CRON ?? "0 0 * * * *",
  runOnStartup: false,
  handler: syncTeams,
});
