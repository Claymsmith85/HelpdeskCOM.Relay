# Plan: Decouple MAILBOX_DRAIN from inbound processing (move-only semantics)

Handoff plan. Read `CLAUDE.md` first (esp. invariant #4 — idempotency / at-least-once) and
`docs/toggle-refactor-plan.md` (the five-toggle refactor this amends). This plan **changes the
meaning of `MAILBOX_DRAIN`** and must land as one unit — the intermediate states are unsafe.

## New semantics (decided with the business)

Today `MAILBOX_DRAIN` is the master gate for ALL inbound processing: off = no lock, no Graph
calls, no ticketing, mail untouched. The new meaning:

> **`MAILBOX_DRAIN` controls ONLY whether handled emails are moved to the processed folder.**
> Every other toggle works as expected regardless. Example: drain OFF + `TICKET_CREATE` ON — the
> email **stays in the inbox** (never moved, never marked read; the relay does not touch
> read/unread state), but a ticket is created from its content, the ack goes out if
> `SUBMITTER_REPLIES` is on, and tagged-reply threading works if `FOLLOWERS_NOTICES` is on.

Toggle matrix after this change (inbound side):

| `MAILBOX_DRAIN` | `TICKET_CREATE` | Behavior |
|---|---|---|
| off | off | Worker returns immediately (nothing it could do). Mail untouched. |
| on | off | Today's "swallow" mode: mail moved to processed with no ticket. |
| off | on | **NEW:** tickets/acks/threading from inbox mail; mail stays in the inbox. |
| on | on | Full pipeline, mail moved (today's normal). |

## The core problem this plan must solve

The move-to-processed IS the idempotency guard (invariant #4): a handled message's id 404s on the
next drain. With drain off, handled mail stays listed — without a replacement marker, **every
15-minute sweep would re-append the same email to its ticket and re-send the ack, forever.** Two
secondary problems follow from the unmoved mail:

- `listInboxMessageIds` returns ONE page capped at `MAIL_DRAIN_BATCH_SIZE`, **oldest first** —
  handled-but-unmoved messages would permanently occupy the page, so mail arriving after the
  first `BATCH_SIZE` messages would **never be listed** (starvation).
- The continuation re-enqueue fires whenever a listing returns a full page
  (`process-mail.ts` ~line 317) and "self-terminates" only because each run *moves* messages out.
  With unmoved mail it would re-enqueue forever (infinite queue churn).

## Design

### 1. Per-message create-once claim blobs (the new idempotency marker)

A message is "handled" when a claim blob exists for it. Invisible to the mailbox (nothing is
moved, no category, no read-state change — per the requirement).

- **New module `src/functions/mail-claims.ts`** (mirror `drain-lock.ts`'s shape: env read, blob
  REST via `buildStorageClient`, module-boundary mockable):
  - `messageClaimBlobName(mailboxKey, messageId)` — `mail-claim-<mailboxKey>-<messageId>`.
    **Preserve the message id's case** (Graph ids are case-sensitive, URL-safe base64 — all legal
    blob-name chars; follow the precedent CLAUDE.md records for `chat-archive`'s claim names:
    never case-fold opaque external ids). `mailboxKey` = `normalizeMailboxKey(mailbox)`.
  - `isMessageClaimed(client, name): Promise<boolean>` (HEAD blob).
  - `claimMessage(client, name, detailJson)` (PUT `If-None-Match: *`; already-exists = fine).
  - `releaseMessageClaim(client, name)` (DELETE, 404-tolerant).
  - Container: `relay-state` (same as alerts; override `MAIL_CLAIM_CONTAINER`). Same
    `AzureWebJobsStorage` account + UAMI ⇒ **no new RBAC**.
- While extracting: lift the create-once idiom out of `alerts.ts`'s `claimDailyAlert` into
  `storage-client.ts` (`claimCreateOnceBlob` / `blobExists` / `deleteBlobIfExists`) and have BOTH
  `alerts.ts` and `mail-claims.ts` consume it, so the two claim users can't drift. (CLAUDE.md
  already describes this shape — implement it.)

**Claim ordering — claim AFTER the side effects, not before** (the `chat-archive` rationale in
CLAUDE.md): ticket append/create and ack are not idempotent-but-recoverable the way an upload is;
claiming first would mean a crash between claim and ticket permanently loses the email's ticket.
So: process message → ticket work → ack → **then** claim (drain off) or move (drain on).

- Claim WRITE failure: log at **ERROR** (not silent — same treatment as a failed move today);
  the message may be re-processed next drain (duplicate append + re-ack — the same at-least-once
  window invariant #4 already documents for a failed move).
- Claim READ failure (storage error on the existence check): **per-message failure** — isolated,
  rethrown at end of drain (queue retry). Never process blind: a missed claim means duplicate
  tickets. (Same "never act blind" rule CLAUDE.md records for chat-archive claims.)

### 2. Gate restructure in `process-mail.ts`

- Top of `processMail`: return early only when **both** `mailboxDrainEnabled()` and
  `ticketCreateEnabled()` are off (nothing to do). Otherwise **acquire the drain lock as today** —
  the lock must serialize drain-off ticketing too, or two instances pass the claim check
  concurrently and create duplicate tickets (the June-2026 bug class the lock exists for).
- Per message id (inbox AND Reprocess listings), **check the claim FIRST, before `getMessage`**:
  - claimed + drain ON → catch-up: `safeMoveToProcessed` only (no fetch, no ticket, no ack),
    then `releaseMessageClaim` best-effort (WARN on failure) so claims don't accumulate.
  - claimed + drain OFF → skip (cheap: one HEAD, zero Graph calls).
  - unclaimed → fetch and run today's pipeline with these ends:
    - ignored sender / `TICKET_CREATE` off → no ticket work; then drain ON: move (as today) /
      drain OFF: **claim** (so NDRs and swallowed mail aren't re-fetched every sweep).
    - full pipeline (create on) → ticket/attachments/ack/threading as today; then drain ON: move
      (claim never written) / drain OFF: claim.
  - The `MAIL_IGNORE_BEFORE` cutoff and reprocess bypass are unchanged (listing filter + guard).
- Reprocess folder note: with drain off, a replayed message is ticketed once, claimed, and stays
  in the Reprocess folder (skipped on later drains); when drain turns on it gets moved. Document
  this in the Reprocess gotcha.

### 3. Listing + continuation fixes

- Extend `listFolderMessageIdsByResource` (graph-mail.ts) with **pagination**: follow
  `@odata.nextLink` until either the whole folder is listed or a hard page budget is hit
  (e.g. 10 pages × batch size — constant, log when the budget truncates). Keep oldest-first.
  The worker then filters claimed ids out and handles at most `MAIL_DRAIN_BATCH_SIZE`
  **unclaimed** messages per run — claimed ids never count toward the cap, so new mail behind a
  wall of unmoved handled mail is always reachable.
- Continuation re-enqueue: base the decision on **unclaimed work remaining** (more unclaimed ids
  were listed than were handled this run), NOT on raw page fullness. An inbox full of claimed,
  unmoved mail must NOT re-enqueue (that was the infinite-churn path). In catch-up mode
  (drain just turned on, many claimed messages to move), moves count as handled work for the cap
  and the continuation, so big backlogs still clear across several short runs.
- Steady-state cost note: drain-off mode costs one storage HEAD per unmoved message per drain
  (15-min sweep). Fine for test volumes; the page budget bounds the pathological case. Not a
  concern once drain is on (mail moves out).

### 3a. `MAIL_IGNORE_BEFORE` (the go-live cutoff) — explicit requirements

Pre-cutoff mail must stay exactly as protected as today — never listed, never ticketed, never
acked, and additionally under the new semantics **never claimed and never moved**, in every
toggle combination. Four rules make that hold:

1. **Pagination preserves the filter.** The inbox listing's server-side
   `receivedDateTime ge <cutoff>` `$filter` (graph-mail.ts / process-mail.ts ~line 243) must be
   carried by the paginated listing — following `@odata.nextLink` continues the same filtered
   query, so every page excludes pre-cutoff mail. Do not rebuild the query per page without the
   filter.
2. **The per-message guard runs BEFORE any claim write.** The existing guard
   (process-mail.ts ~line 380) returns with NO side effect for a pre-cutoff message (it covers
   the always-included triggering id, which bypasses the listing filter). Under the new flow the
   skip must remain side-effect-free: **do not claim it, do not move it** — a claim would mark it
   "handled" and the drain-on catch-up would then file it into the processed folder.
3. **Catch-up moves only CLAIMED messages.** Since pre-cutoff mail can never acquire a claim
   (rules 1–2), the drain-on catch-up can never move it — belt and braces on top of the listing
   filter already excluding it from the ids being walked.
4. **Swallow mode (`drain on + create off`) is unaffected**: the cutoff guard sits before the
   create-off short-circuit, so pre-cutoff mail is not "swallowed" either.

The one deliberate exception stays deliberate: the **Reprocess folder bypasses the cutoff** (the
whole point of dropping old mail there is to force it through) — unchanged.

### 3b. Deploy wiring for `MAIL_IGNORE_BEFORE`

Today the cutoff is not deploy-managed at all: no Deploy.yml entry, no app setting on either app —
both run on the hardcoded default (`2026-06-19T22:00:00Z`, process-mail.ts ~line 127). Make it a
first-class deploy setting:

- Add an app-settings entry to `.github/workflows/Deploy.yml` (next to the toggle entries):

  ```json
  {
    "name": "MAIL_IGNORE_BEFORE",
    "slotSetting": false,
    "value": "${{ vars.MAIL_IGNORE_BEFORE }}"
  }
  ```

- The variable MUST be **environment-scoped** (a per-environment value in the live repo's
  `Production` / `Development` environments), never repository-level shared: the two environments
  need DIFFERENT values, and pushing a future (go-live) timestamp to the Dev app would tell it to
  ignore every current test email — silently killing the test loop.
- **Safe when unset/empty**: the code reads it through `envInstantMs`, which falls back to the
  hardcoded June default for a missing/blank/unparseable value — so an environment without the
  variable behaves exactly as today.
- Value format: any `Date.parse`-able instant; ISO-8601 UTC with a `Z` is the convention
  (e.g. `2026-09-01T13:00:00Z`). Production's value should be set to the actual go-live instant
  as part of the go-live runbook, BEFORE `MAILBOX_DRAIN`/`TICKET_CREATE` are turned on there —
  otherwise everything the prod mailboxes accumulated since June becomes ticket-eligible at
  switch-on.
- Operational note: unlike the five toggles, this is read **once at module load**, not
  per-invocation — it takes effect via the app restart that accompanies a deploy or settings
  change, which is fine; just don't expect a hot flip.

### 4. What does NOT change

- `SUBMITTER_REPLIES`, `AGENT_NOTICES`, `FOLLOWERS_NOTICES`, `USERMGMT_TOGGLE`: untouched.
- The webhook (`helpdesk.ts`): untouched.
- Drain-lock, echo/loop guards, marker neutralization, audience check, oversize policy: untouched.
- `notify` / `sweep-inbox` / `renew-subscriptions` / `mail-poison`: untouched (they only enqueue
  or renew; the worker's gates decide).

### 5. Docs

- `env.ts` helper comment for `mailboxDrainEnabled` (move-only meaning) and `ticketCreateEnabled`
  (now the switch that decides whether inbound mail is *processed* at all when drain is off).
- `README.md` toggle table + Inbound Flow; `CLAUDE.md` invariant #4 (claims are the no-move
  idempotency guard; move remains the primary guard when drain is on) and the toggles paragraph;
  Reprocess gotcha; note `docs/toggle-refactor-plan.md` is amended by this plan.

## Tests (follow existing conventions)

- **New `mail-claims.test.ts`** (axios-mock-adapter, like `drain-lock.test.ts`): name building
  (case preserved), claim/exists/release, 409-on-existing tolerated, container create-on-first-use.
- **`process-mail.handler.test.ts`** (mock `./mail-claims` at the module boundary, like
  `./drain-lock`):
  - drain OFF + create ON: ticket created + ack sent (submitter on), `moveMessageToFolder` NOT
    called, claim written.
  - same message re-drained (claim exists): zero Graph fetches, zero Helpdesk calls, no ack.
  - drain turned ON with claim present: move called, no ticket calls, claim released.
  - drain OFF + create ON + ignored sender: claimed, not moved, no ticket.
  - both off: no lock, no listing.
  - claim-read failure: per-message failure isolated + drain rethrows; no ticket created.
  - continuation: all-claimed full page → NO re-enqueue; page with unclaimed overflow → re-enqueue.
  - cutoff: a pre-cutoff triggering message (drain off + create on) is skipped with NO claim
    written and NO ticket; after flipping drain on, it is still NOT moved (no claim exists).
- **`graph-mail.test.ts`**: pagination follows nextLink, respects the page budget, keeps order,
  and carries the `receivedAfterIso` filter across pages.

## Acceptance

- `npx tsc -p tsconfig.json`, `npm run lint`, `npm test` green (pre-existing
  `graph-directory.test.ts` failure excepted).
- `Deploy.yml` carries the `MAIL_IGNORE_BEFORE` app-settings entry (§3b); the README env-var
  table documents its per-environment values and the unset-falls-back-to-default behavior.
- Manual (dev app): with drain off + create on, email the dev mailbox → ticket appears, mail
  stays in inbox unread; wait two sweep cycles → no duplicate ticket messages, no repeat acks;
  flip drain on → mail files into the processed folder with no new ticket activity.
