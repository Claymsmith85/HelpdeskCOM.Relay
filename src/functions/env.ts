// src/functions/env.ts
// Tiny environment-variable helpers shared across the functions. Centralizes the two recurring
// idioms — parse a positive number with a safe default, and read a required value — so each call
// site stops re-implementing the NaN/zero/negative guard (and a typo can't silently disable a cap).
// No module-load side effects, so it is freely importable.

/**
 * Parse a positive number from an env value, falling back to `fallback` for a
 * missing/non-numeric/non-positive value. (Without the guard, a typo like "100mb" -> NaN would make
 * a later `size > NaN` always false and silently disable the cap.) Pass { integer: true } to floor
 * the result for count-like settings (e.g. a batch size).
 */
export function envPositiveNumber(
  raw: string | undefined,
  fallback: number,
  opts: { integer?: boolean } = {}
): number {
  const n = Number(raw);
  if (!(Number.isFinite(n) && n > 0)) return fallback;
  return opts.integer ? Math.floor(n) : n;
}

/**
 * Read a required env var, throwing a consistent error if it is unset/empty.
 */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * Parse an on/off feature toggle from an env value. Case-insensitive + trimmed:
 * `true`/`on`/`1`/`yes` → ON; `false`/`off`/`0`/`no` → OFF; anything else — including unset or
 * empty — returns `fallback`. (An unset GitHub `vars.*` resolves to an empty app-setting value, so
 * empty MUST behave as the fallback.) Intended to be read PER-INVOCATION (not cached at module load)
 * so the switch can be flipped from an app setting without a code redeploy.
 */
export function envFlag(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "true" || v === "on" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "off" || v === "0" || v === "no") return false;
  return fallback;
}

/**
 * Switch for inbound mailbox automation (`MAILBOX_DRAIN`). ON lets `process-mail` take the drain
 * lock, list Inbox/Reprocess, fetch messages, and move handled mail to the processed folder. OFF —
 * the default when unset/empty — returns before the lock or any Graph call and leaves mail untouched
 * for a later notification/sweep to catch up. Independent of `TICKET_CREATE`: drain ON + ticket
 * creation OFF deliberately moves mail without a ticket.
 */
export function mailboxDrainEnabled(): boolean {
  return envFlag(process.env.MAILBOX_DRAIN, false);
}

/**
 * Switch for inbound ticket automation (`TICKET_CREATE`). ON lets an active mailbox drain find or
 * create/append tickets, upload attachment links, and add oversize notes. OFF — the default when
 * unset/empty — performs no inbound Helpdesk reads/writes; an enabled drain still moves the message
 * to processed. Reply-received acknowledgements also require `SUBMITTER_REPLIES`, and tagged
 * non-requester threading also requires `FOLLOWERS_NOTICES`.
 */
export function ticketCreateEnabled(): boolean {
  return envFlag(process.env.TICKET_CREATE, false);
}

/**
 * Switch for submitter-facing relay email (`SUBMITTER_REPLIES`). ON enables webhook emails for agent
 * replies and inbound reply-received acknowledgements after a ticket append. OFF — the default when
 * unset/empty — keeps submitters silent. Acknowledgements additionally require `TICKET_CREATE` and
 * remain suppressed for Reprocess replays and relayed non-requester threads. Dev and Prod share
 * one Helpdesk account, so this webhook-driven flag must be ON in at most one environment.
 */
export function submitterRepliesEnabled(): boolean {
  return envFlag(process.env.SUBMITTER_REPLIES, false);
}

/**
 * Switch for assigned-agent notices (`AGENT_NOTICES`). ON lets the Helpdesk webhook send the assigned
 * agent public-message copies, including their own Helpdesk-authored replies; a message relayed from
 * that same email address is suppressed as an auto-responder loop guard. OFF — the default when
 * unset/empty — sends no assigned-agent copies. The webhook is dark only when this,
 * `SUBMITTER_REPLIES`, and `FOLLOWERS_NOTICES` are all OFF. Dev and Prod share one Helpdesk
 * account, so this webhook-driven flag must be ON in at most one environment.
 */
export function agentNoticesEnabled(): boolean {
  return envFlag(process.env.AGENT_NOTICES, false);
}

/**
 * Switch for follower / people-in-the-loop notices and their non-requester reply threading
 * (`FOLLOWERS_NOTICES`). ON enables the webhook notice audience and, when `MAILBOX_DRAIN` and
 * `TICKET_CREATE` are also ON, tagged non-requester replies thread into the referenced ticket. OFF —
 * the default when unset/empty — sends no follower/cc notices and performs no by-reference inbound
 * lookup. The webhook is dark only when this, `SUBMITTER_REPLIES`, and `AGENT_NOTICES` are all OFF.
 * Dev and Prod share one Helpdesk account, so this webhook-driven flag must be ON in at most one
 * environment.
 */
export function followersNoticesEnabled(): boolean {
  return envFlag(process.env.FOLLOWERS_NOTICES, false);
}

/**
 * Master switch for AAD-group → Helpdesk user/team management (`USERMGMT_TOGGLE`). OFF — the default
 * when unset/empty — means the `sync-teams` timer does nothing: no agent invite/update/delete. The
 * sync is a reconcile against live state, so a paused run loses nothing — the next enabled run
 * catches up. Default-OFF for the same staged-rollout reason as the other feature switches.
 */
export function userMgmtEnabled(): boolean {
  return envFlag(process.env.USERMGMT_TOGGLE, false);
}

/**
 * Parse an instant (any format `Date.parse` accepts — ISO-8601 with a `Z`/offset is safest) from
 * an env value into epoch milliseconds, falling back to `fallbackIso` when the value is
 * missing/unparseable. Used for cutoff-style settings (e.g. "ignore mail received before go-live").
 * `fallbackIso` is a constant the caller controls, so it is expected to parse.
 */
export function envInstantMs(raw: string | undefined, fallbackIso: string): number {
  const fromRaw = raw ? Date.parse(raw) : NaN;
  if (Number.isFinite(fromRaw)) return fromRaw;
  return Date.parse(fallbackIso);
}
