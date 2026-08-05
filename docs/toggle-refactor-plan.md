# Toggle Refactor Plan — Five Independent Feature Switches

Handoff plan for implementing granular feature toggles in the CoreSpecialty Mail → Helpdesk relay.
Read `CLAUDE.md` first — it documents the architecture and the cross-file invariants (echo
suppression, loop guards, idempotency) that every change below must preserve.

## Context / why

Today the relay has two coarse switches:

- `TICKETING_TOGGLE` — master switch gating ALL of `process-mail` (drain + ticketing + acks) and
  the `helpdesk` webhook's requester flow (customFields patch + agent-reply emails).
- `NOTICES_TOGGLE` — follower / people-in-the-loop notices (webhook pass, independent of
  ticketing since commit `7289ca4`) + non-requester `[#shortID]` reply threading (inbound side).

The business wants to test each portion of the Helpdesk integration in isolation (and stage
go-live piecewise), which the coarse switches cannot express — e.g. "drain the mailbox but create
no tickets", or "send follower notices but nothing to the submitter". This refactor replaces the
two switches with **five independent toggles**. `USERMGMT_TOGGLE` is untouched.

## The five toggles

All use `envFlag` semantics (`true`/`on`/`1`/`yes` = ON; unset/empty/anything else = OFF), are
**default OFF**, are **read per-invocation** (flip via app setting, no redeploy), and are fully
independent — any of the 32 combinations is legal.

| Toggle | ON | OFF |
|---|---|---|
| `MAILBOX_DRAIN` | Inbound mail automation runs: drain lock, inbox + Reprocess listing, message fetch, and the move of handled mail to the processed folder. | `process-mail` returns at the top of the handler (before the drain lock / any Graph call). Mail sits untouched; notifications/sweeps keep enqueuing (caught up when re-enabled). |
| `TICKET_CREATE` | Drained emails drive ticket work: find-or-create, append, attachment upload + links, oversize note. | No ticket reads/writes from inbound mail. **With `MAILBOX_DRAIN` on, mail is still moved to the processed folder WITHOUT a ticket — swallowed by design** (recoverable via the Reprocess folder). |
| `SUBMITTER_REPLIES` | Submitter-facing email: the webhook emails agent replies to the requester, and the inbound worker sends the reply-received ack on appends. | The submitter hears nothing from the relay. |
| `AGENT_NOTICES` | **New audience.** The ticket's assigned agent gets an email copy of every **public message** event on their ticket — submitter replies AND agent replies, **including their own** (deliberately no author-exclusion for this audience). | Agents get nothing. |
| `FOLLOWERS_NOTICES` | Rename of `NOTICES_TOGGLE`, semantics unchanged: follower / people-in-the-loop notice pass (webhook) + non-requester `[#shortID]` reply threading (inbound). | No follower/cc notices; tagged non-requester replies open new tickets (pre-feature behavior). |

Cross-toggle interactions (make these exact):

- The reply-received ack requires `TICKET_CREATE` (an append happened) **and** `SUBMITTER_REPLIES`
  (may email the submitter), and remains suppressed for reprocess replays and relayed
  non-requester threads (existing `suppressAck` logic — keep it).
- The inbound threading half of `FOLLOWERS_NOTICES` also requires `MAILBOX_DRAIN` (mail must be
  processed) and `TICKET_CREATE` (a threaded reply is a ticket append). Do not run the by-ref
  lookup when `TICKET_CREATE` is off — the reply would be swallowed either way and the lookup
  costs API calls.
- The `helpdesk` webhook is dark (immediate 200) only when `SUBMITTER_REPLIES`, `AGENT_NOTICES`,
  and `FOLLOWERS_NOTICES` are ALL off.
- The webhook's `tickets.create` customFields patch (`customFields.email` ← requester) runs
  whenever the webhook is not dark. It sends no email and is an idempotent same-value write; it
  exists so submitter replies work on tickets created while `SUBMITTER_REPLIES` was off.

⚠️ **Environment double-send caution (document prominently):** dev and prod share the one
Helpdesk account, so BOTH function apps receive every webhook. Any webhook-driven toggle
(`SUBMITTER_REPLIES`, `AGENT_NOTICES`, `FOLLOWERS_NOTICES`) must be ON in at most one
environment at a time, or every recipient is double-emailed.

## Implementation map

### 1. `src/functions/env.ts`
Remove `ticketingEnabled` and `noticesEnabled`. Add five helpers, one per toggle
(`mailboxDrainEnabled`, `ticketCreateEnabled`, `submitterRepliesEnabled`, `agentNoticesEnabled`,
`followersNoticesEnabled`), each `envFlag(process.env.<NAME>, false)` with a doc comment stating
its ON/OFF contract and the interactions above. Update `env.test.ts` (mirror the existing
default-OFF describe).

### 2. `src/functions/process-mail.ts`
- Top-of-handler gate: `ticketingEnabled()` → `mailboxDrainEnabled()`. Same behavior: off = no
  lock, no listing, no move, immediate return.
- In `processSingleMessage`, after the sender loop-guard and cutoff checks: if
  `!ticketCreateEnabled()`, step-log ("Ticket automation off — message moved without ticketing")
  and skip straight to `safeMoveToProcessed` — no requester lookup, no ticket create/append, no
  attachments, no oversize note, no ack, no by-ref threading.
- Threading block condition: `noticesEnabled()` → `followersNoticesEnabled()` (it already lives
  inside the ticket path, which now implies `TICKET_CREATE` is on).
- Ack call site (`handleExistingTicket`): add `submitterRepliesEnabled()` to the existing
  `suppressAck` logic — e.g. compute `suppressAck: reprocess || relayedFrom !== undefined ||
  !submitterRepliesEnabled()` at the call site, and keep the step log naming the reason.

### 3. `src/functions/helpdesk.ts`
- Replace the current two-gate structure (`ticketingOn`/`noticesOn`) with:
  - `const submitterOn = submitterRepliesEnabled(); const agentOn = agentNoticesEnabled(); const followersOn = followersNoticesEnabled();`
  - Dark gate: all three off → 200 immediately (keep the load-bearing 200 comment).
  - Notice pass: call `sendTicketNotices` when `agentOn || followersOn`, passing which audiences
    are enabled (see §4). Keep it BEFORE the requester gates and best-effort (never throw).
  - Create branch: patch customFields whenever reached (webhook not dark); the agent-reply email
    inside it, and the whole update-branch send, additionally require `submitterOn`.
- Keep `isSystemNoteText` import and all existing requester gates (email-sourced / non-agent /
  private / system-note / missing customFields.email) unchanged.

### 4. `src/functions/ticket-notices.ts`
- `sendTicketNotices` gains audience flags in its options: `{ followers: boolean; agent: boolean }`
  (explicit parameters, not env reads, so the module stays freely testable).
- Follower/cc behavior: exactly as today, executed only when `followers` is true (classification,
  extraction, exclusions, visibility ladder, per-recipient isolation, raw-array logging).
- **New assigned-agent audience**, executed only when `agent` is true:
  - Recipient: `payload.payload.assignment?.agent?.ID`, resolved to an email via the existing
    lazily-memoized `getAgents()` (shared with the extractor — still at most one `listAgents`
    call per invocation). No assigned agent or unresolvable ID → step-log and skip.
  - Events: **public message events only** (not private notes, not system notes, not
    status/assignment/audience changes — "copies of all emails", and private notes are not
    emails).
  - **Do NOT apply the author exclusion** — the agent explicitly receives copies of their own
    replies (per business decision). Do still apply `shouldSuppressRecipient` and the email-shape
    check. If the agent's address equals the requester's, they may receive both the submitter
    copy and the agent copy — accepted, note it in the module header.
  - Reuse `noticeMessageEmail` for the body; send from the same mailbox as the follower pass.
  - Extend the `Notices: done` summary log with per-audience counts.
- Dedupe across audiences: if the assigned agent is ALSO a follower/cc recipient and both
  audiences fire for the same event, send them ONE copy (agent-audience rules win, i.e. they get
  it even when they authored it).

### 5. `.github/workflows/Deploy.yml`
Replace the `TICKETING_TOGGLE` and `NOTICES_TOGGLE` app-setting entries with the five new names
(`${{ vars.<NAME> }}` each). Note for the operator: the repo currently has **no GitHub
environments/variables configured** — toggles are managed directly as portal app settings — so
after any deploy, re-verify the five settings on the app (or set up the GitHub variables to
match before deploying).

### 6. Settings migration (operator runbook — include in the PR description)
- Current test posture (dev app runs everything, prod dark until go-live):
  - **Dev app**: `MAILBOX_DRAIN=true`, `TICKET_CREATE=true`, `SUBMITTER_REPLIES=true`,
    `AGENT_NOTICES` per test need, `FOLLOWERS_NOTICES=true`.
  - **Prod app**: all five `false`/absent.
- Delete the retired `TICKETING_TOGGLE` and `NOTICES_TOGGLE` settings from both apps after the
  new build is live (the new code must not read them anywhere — grep to confirm).
- Go-live later = flip prod's five on (with prod `MAILBOX_ADDRESSES`) and dev's five off in one
  change window (never both webhooks live).

### 7. Tests (follow existing conventions — module-boundary jest.mock factories; see the test
files' headers)
- `env.test.ts`: five helpers, default OFF / explicit on / explicit off.
- `process-mail.handler.test.ts`:
  - `MAILBOX_DRAIN` off → no lock/listing/move (rename existing TICKETING describe).
  - Drain on + `TICKET_CREATE` off → message MOVED to processed, zero Helpdesk calls, no ack.
  - Drain + create on, `SUBMITTER_REPLIES` off → append happens, ack NOT sent.
  - Threading tests: set `FOLLOWERS_NOTICES` (rename from `NOTICES_TOGGLE`) and both drain+create.
- `helpdesk.handler.test.ts`:
  - All three webhook toggles off → 200, nothing called.
  - `SUBMITTER_REPLIES` only → requester emails + patch, no notice pass.
  - `FOLLOWERS_NOTICES` only → notice pass called with `{followers: true, agent: false}`, no
    requester email, patch still runs on create.
  - `AGENT_NOTICES` only → notice pass called with `{agent: true}`.
- `ticket-notices.test.ts`:
  - Agent audience: assigned agent gets public messages incl. their OWN reply (author exclusion
    deliberately absent); gets nothing for private notes/status/assignment; unresolvable
    assignment skipped; single-copy dedupe when agent is also a follower; `followers:false,
    agent:true` sends only the agent copy.
  - Existing follower/cc tests: pass `{followers: true, agent: false}`.
- Note: `graph-directory.test.ts` has one pre-existing unrelated failure — do not chase it.

### 8. Docs
- `README.md`: replace the `TICKETING_TOGGLE`/`NOTICES_TOGGLE` env-table rows with the five new
  rows (ON/OFF contracts + the double-send caution); update the Inbound Flow, Webhook Flow, and
  Outbound Email Behavior sections to name the gating toggle per behavior.
- `CLAUDE.md`: rewrite the "Master feature toggles" paragraph for the five-switch model (keep
  `USERMGMT_TOGGLE` text); update the `helpdesk.ts` / `process-mail.ts` architecture bullets and
  invariant #1 (agent audience deliberately includes the author — it is NOT an echo-control
  violation) and #3 (threading requires drain+create+followers).

## Invariants that must survive (verify before merging)

1. Echo suppression for the **follower/cc** audience is unchanged (requester, author, marker
   sender excluded; forged markers neutralized). The agent audience's include-own-replies is a
   deliberate exception scoped to that audience only.
2. Every outbound recipient still passes `shouldSuppressRecipient` (no sends into drain
   mailboxes).
3. The webhook never returns non-200 for processed deliveries (Helpdesk redelivery = duplicate
   email).
4. Idempotency: with drain on, handled mail is always moved to processed exactly as today; the
   at-least-once semantics and drain lock are untouched.
5. `USERMGMT_TOGGLE` and the team-sync/alert machinery are untouched.

## Acceptance criteria

- `npx tsc -p tsconfig.json`, `npm run lint`, `npm test` green (bar the pre-existing
  `graph-directory.test.ts` failure).
- No references to `TICKETING_TOGGLE` / `ticketingEnabled` / `NOTICES_TOGGLE` / `noticesEnabled`
  remain in `src/` or `Deploy.yml`.
- Key manual matrix on the dev app (test ticket with follower + loop person + assigned agent):
  | DRAIN | CREATE | SUBMITTER | AGENT | FOLLOWERS | Expected |
  |---|---|---|---|---|---|
  | off | – | – | – | – | inbound mail untouched |
  | on | off | – | – | – | mail moved, no ticket, no email |
  | on | on | off | off | off | ticket created/appended silently |
  | on | on | on | off | off | + submitter gets agent replies & acks |
  | – | – | – | on | off | assigned agent gets public message copies incl. own |
  | on | on | – | – | on | follower/cc notices + tagged replies thread |
