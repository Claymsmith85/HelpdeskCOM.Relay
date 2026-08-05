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
 * Master switch for ALL mail-flow interaction (`TICKETING_TOGGLE`). OFF — the default when the var is
 * unset/empty — means the inbound worker (`process-mail`) and the Helpdesk webhook (`helpdesk`) do
 * nothing: no ticket create/update and no outbound email at all. The worker leaves mail UNTOUCHED in
 * the mailbox (never moved to the processed folder), so flipping the toggle back ON catches up the
 * whole OFF-window backlog on the next drain. Default-OFF is deliberate: a freshly deployed
 * environment stays dark until the variable is explicitly set to `true`.
 */
export function ticketingEnabled(): boolean {
  return envFlag(process.env.TICKETING_TOGGLE, false);
}

/**
 * Master switch for AAD-group → Helpdesk user/team management (`USERMGMT_TOGGLE`). OFF — the default
 * when unset/empty — means the `sync-teams` timer does nothing: no agent invite/update/delete. The
 * sync is a reconcile against live state, so a paused run loses nothing — the next enabled run
 * catches up. Default-OFF for the same staged-rollout reason as `ticketingEnabled`.
 */
export function userMgmtEnabled(): boolean {
  return envFlag(process.env.USERMGMT_TOGGLE, false);
}

/**
 * Switch for follower / people-in-the-loop ticket notices AND the non-requester reply threading
 * that closes their loop (`NOTICES_TOGGLE`). OFF — the default when unset/empty — means the
 * `helpdesk` webhook sends no follower/cc notices and `process-mail` does not thread a
 * `[#shortID]`-tagged reply from a non-requester (it opens a new ticket, today's behavior). One
 * flag gates BOTH halves deliberately: a notice invites a reply, and the reply must thread — the
 * halves are one conversation loop, so enabling only one is an inconsistent ops state.
 *
 * The webhook's notice pass runs INDEPENDENTLY of `ticketingEnabled` (notices-only mode, so Dev —
 * which shares the Helpdesk account and receives the same webhooks — can test notices with its
 * mail flow off). Because every environment sees the same webhooks, enable notices in ONLY ONE
 * environment at a time or every follower/cc is double-emailed. The threading half still requires
 * ticketing (with mail flow off, inbound mail isn't processed at all). Default-OFF for the same
 * staged-rollout reason as the other `*_TOGGLE`s.
 */
export function noticesEnabled(): boolean {
  return envFlag(process.env.NOTICES_TOGGLE, false);
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
