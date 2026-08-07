> **CI/CD Hardening Rules:** [Confluence - CI/CD Hardening Rules](https://corespecialty.atlassian.net/wiki/spaces/DEVOPS/pages/357957633/CI+CD+Hardening+Rules)

# CoreSpecialty Mail → Helpdesk Relay
Azure Functions v4 · Node.js 24.x · TypeScript · Run From Package

This service relays inbound email into Helpdesk.com, stores attachments in SharePoint Online, and sends outbound email — all through **Microsoft Graph and the native M365 shared mailboxes** (no SendGrid). Inbound mail is delivered by Graph change notifications; outbound mail is sent via Graph `sendMail`.

It is deployed as two Azure Function Apps behind APIM:

- Dev: `funcapp-core-helpdesk-dev000`
- Prod: `funcapp-core-helpdesk-prod000`

Runtime:
- Azure Functions v4
- Node.js 24.x
- `WEBSITE_RUN_FROM_PACKAGE=1`

Public ingress is through Azure API Management (`api.corespecialty.com`).

---

# Repository Layout

```
src/
  index.ts                 # app.setup() + side-effect imports that register the functions
  functions/
    notify.ts              # HTTP fn:  Graph change notification -> validate -> enqueue
    process-mail.ts        # Queue fn: claim-aware mail scan -> optional ticket/ack -> move or claim
    helpdesk.ts            # HTTP fn: Helpdesk webhook -> requester, assigned-agent, follower/cc mail
    renew-subscriptions.ts # Timer fn: create/renew Graph mailbox subscriptions (runOnStartup)
    sweep-inbox.ts         # Timer fn: safety-net — enqueue a drain per mailbox (runOnStartup)
    clear-mail-queue.ts     # App-start hook: optionally clear stale primary queue messages
    mail-poison.ts         # Queue fn: log dead-lettered drains at error severity (alertable)
    graph-client.ts        # Shared app-only Graph token + axios client (timeouts + retry)
    http-retry.ts          # Shared axios retry policy (429/503 + idempotent-only 5xx)
    graph-mail.ts          # Graph mail I/O (read message/attachments, sendMail, move, builders)
    sharepoint.ts          # Graph upload helpers (site/drive/folder; content PUT or chunked session)
    helpdesk-client.ts     # Helpdesk REST client + ticket operations
    rate-limit.ts          # Process-local fixed-interval Helpdesk request pacing
    routing.ts             # Inbox -> team routing + inbound loop guard
    logging.ts             # Shared step / buffered loggers
    subscriptions.ts       # Graph subscription create/renew
    subject.ts             # "[#shortID]" subject-threading helpers
    *.test.ts              # Jest test suite (see "Testing")
  types/                   # Hand-written payload/response types
.github/workflows/Deploy.yml
host.json
jest.config.js             # Jest + ts-jest config
tsconfig.json              # App build (NodeNext, excludes *.test.ts)
tsconfig.test.json         # Test build (CommonJS, used by ts-jest)
```

Functions are registered at module load (`app.http` / `app.storageQueue` / `app.timer`); `index.ts` runs `app.setup({ enableHttpStream: true })` and imports them for side-effect registration.

---

# Architecture Overview

## Inbound Email Flow

```
Sender → native shared mailbox (Inbox)
       → Graph change notification → notify (HTTP) → 202 + enqueue {mailbox, messageId}
       → Storage Queue             → process-mail (Queue)
             → MAILBOX_DRAIN || TICKET_CREATE: lock + paginated list + claim check
             → TICKET_CREATE: find/create ticket + attachments/SharePoint
             → SUBMITTER_REPLIES: sendMail acknowledgement on an append
             → MAILBOX_DRAIN: move handled message to "HelpdeskProcessed"
               otherwise: write a create-once storage claim (idempotency)
```

| `MAILBOX_DRAIN` | `TICKET_CREATE` | Inbound result |
|---|---|---|
| off | off | No lock/listing/storage/Graph work; mail is untouched. |
| on | off | Handled mail moves to processed without a ticket. |
| off | on | Ticketing, attachments, threading, and eligible acks run; mail stays unread in place and receives a storage claim. |
| on | on | Full ticket pipeline; handled mail moves to processed. |

1. **`notify`** receives the Graph notification at `/api/notify` (through APIM). It:
   - Answers the subscription validation handshake (echoes `validationToken` as `text/plain`).
   - Verifies `clientState` against `GRAPH_SUBSCRIPTION_CLIENT_STATE`.
   - Enqueues `{ mailbox, messageId }` onto the `mail-notifications` Storage Queue and returns `202` (Graph requires an ack within ~3 s).

2. **`process-mail`** (queue trigger) does the work:
   - Runs whenever **either `MAILBOX_DRAIN` or `TICKET_CREATE` is on**. It takes the same per-mailbox lock, lists Inbox + Reprocess oldest-first across up to ten Graph pages, and checks a per-message create-once claim before fetching content. The invocation is capped at `MAIL_DRAIN_BATCH_SIZE` actionable messages across both folders (default 10); claimed mail skipped while drain is off does not consume the cap, so it cannot starve newer mail within the bounded listing walk. A continuation is queued only when unclaimed ticket work or claimed catch-up moves remain beyond the cap—not because a raw Graph page happened to be full.
   - Drain-off steady state costs one storage `HEAD` per visible message per sweep. The ten-page listing budget bounds pathological folders and logs when it truncates; this mode is intended for the low-volume test posture. Once drain is enabled, catch-up moves remove claimed messages from the mailbox and that recurring scan cost disappears.
   - **Ignores mail received before `MAIL_IGNORE_BEFORE`** (default the go-live boundary): the inbox listing is filtered server-side (`receivedDateTime ge …`) on every followed page, so the pre-go-live backlog is normally never fetched. The always-included triggering id may be fetched so its timestamp can be checked by the backstop guard; once identified as pre-cutoff, it is never ticketed, acknowledged, claimed, or moved in any toggle combination.
   - **Replays the `MAIL_REPROCESS_FOLDER`** (default `Reprocess`, created on demand): every active worker scans this folder — drop a message into it and the next run replays it **as if it just arrived**. Reprocess intentionally bypasses `MAIL_IGNORE_BEFORE` and suppresses the requester acknowledgement. With ticketing on and drain off, it is ticketed once, claimed, and stays in Reprocess; later drain-on catch-up moves it without repeating ticket work. With ticketing off and drain on it is moved without ticketing. Pickup latency is one sweep cycle (`MAIL_SWEEP_CRON`, ≤15 min by default) since moving mail into a folder raises no inbox notification.
   - Fetches the message (plain-text body via `Prefer: outlook.body-content-type="text"`). Attachments are listed/fetched only when `TICKET_CREATE` is on.
   - Ignores loop/system senders (`helpdesk.com`, the `onmicrosoft.com` tenant) and bounce senders (`postmaster@`/`mailer-daemon@`, exact local part, any domain).
   - **Never dispatches to one of our own drain mailboxes**: any outbound (ack or agent reply) addressed to a `MAILBOX_ADDRESSES` mailbox — by exact match, *or* the same mailbox under an alias company domain (`corespecialty.com` / `corespecialtyins.com`, set by `RELAY_IN_SCOPE_DOMAINS`), e.g. `escape@corespecialty.com` for a configured `escape@corespecialtyins.com` — is suppressed, otherwise it would land back in a drained inbox, open a fresh ticket, and ping-pong. This is scoped to the drain mailboxes (and their alias-domain spellings), **not** the whole company domain, so ordinary internal requesters still get replies. (Outbound counterpart to the ignored-sender guard.)
   - With **`TICKET_CREATE` on**, looks up the requester's existing tickets and either **updates** a matched ticket or **creates** a new one, uploads eligible attachments to SharePoint, and adds oversize notes regardless of drain mode. With it off, the worker performs zero inbound Helpdesk reads/writes; if drain is on, it moves the message without a ticket (recoverable by moving it to `MAIL_REPROCESS_FOLDER`). If both toggles are off, the worker returns before the lock or any Graph/storage call.
   - Sends a reply-received acknowledgement **only when an inbound updates an existing ticket and `SUBMITTER_REPLIES` is on** — **from the receiving shared mailbox**. Reprocess replays and relayed non-requester threads remain silent. A **new** ticket is always opened silently: no "ticket has been created" notice is sent to the requester, from the relay or from Helpdesk (Helpdesk's own requester notifications are disabled in Helpdesk's admin settings, so Helpdesk sends nothing either).
   - For each attachment over the per-file limit, skips that file, uploads eligible siblings, and adds an agent `System note:` describing the overage.
   - Sends a debug email on **errors only** (when `SEND_DEBUG_EMAIL=true`).
   - **Finalizes after ticket work and any acknowledgement.** With `MAILBOX_DRAIN` on, it moves handled mail to `MAIL_PROCESSED_FOLDER`; a previously claimed message is normally catch-up moved without fetching its content or repeating ticket activity. Its claim is released only after a successful move or after an ambiguous move `404` is verified with a source-id `GET`. With drain off, it leaves the message unread and in place and writes a create-once blob claim instead. Later sweeps skip claimed mail before per-message Graph fetches. A claim-read error fails that message closed and is retried; a claim-write or move failure is ERROR-logged and leaves the existing at-least-once duplicate window.

Ticket matching prefers the `[#shortID]` threading tag in the subject, then falls back to a guarded subject-substring match (an empty ticket subject never matches). See **Subject Threading & Requester Addresses**.

With **`TICKET_CREATE` + `FOLLOWERS_NOTICES`** on, a tagged reply from a **non-requester** (a follower / person-in-the-loop replying to a notice — invisible to the requester-scoped ticket list) is resolved by shortID (`GET /tickets?shortID=…`, client-side verified so an ignored filter can only miss, never mis-match) and **threads into the original ticket** instead of opening a duplicate, whether drain is on or off. It is prefixed with a `[Relayed from <sender>]` attribution line (the API author is a generic "client"; a hand-typed marker on ordinary inbound mail is neutralized so attribution can't be spoofed). The tag is authoritative — it outranks the subject-substring fallback matching one of the sender's own tickets — but only for the ticket's **audience**: the sender must be its requester, a person-in-the-loop, or a follower agent, or the reply falls through to a silent new ticket. Relayed threads get **no reply-received ack**. When ticket creation or follower notices are off, the worker skips the by-reference lookup. A definitive 4xx falls through to a new ticket; a 5xx or transient 408/429 rethrows before any side effect so the queue retries rather than mis-filing the reply.

Auth: the function key / APIM `subscription-key` is carried in the query string of `GRAPH_NOTIFICATION_URL` (Graph calls the exact URL, and appends `&validationToken=...` on validation). Treat the full notification URL (with key) as a secret.

---

## Helpdesk Webhook Flow

```
Helpdesk → APIM → helpdesk function → Graph sendMail (from the shared mailbox)
```

Registered webhook events: `tickets.create`, `tickets.update`.

The `helpdesk` function is dark (immediate `200`) only when `SUBMITTER_REPLIES`, `AGENT_NOTICES`, and `FOLLOWERS_NOTICES` are all off. Otherwise:
- On UI-authored `tickets.create` events, patches `customFields.email` with the requester address whenever the webhook is not dark. With **`SUBMITTER_REPLIES` on**, emails the requester only when the create's last event is agent-authored. Customer-emails-in (client-authored) are already handled by `process-mail`, so they are **not echoed back**.
- On `tickets.update`, with **`SUBMITTER_REPLIES` on**, emails the requester when the last event is **agent-authored**, not sourced from email, not a private message, and not a `System note:`.
- Sends the agent's reply **text only** (Graph `sendMail`) — attachments are not forwarded to the requester.
- Does not update ticket status; does not create private notes.
- **Assigned-agent notices** (`AGENT_NOTICES`, default OFF): the currently assigned agent gets a copy of every public message event, including their own Helpdesk-authored replies. Private/system notes and non-message changes do not qualify. If the assigned agent is also a follower/cc recipient, they get one agent-rules copy; if their address also equals the requester, the separate submitter and agent paths may each send a copy by design. A tagged email reply already relayed from that same agent is not copied back to them (auto-responder loop guard). Assignment alone does not authorize inbound threading: an agent replying by email threads only if they are also the requester, a follower, or a person in the loop; otherwise the reply follows the normal new-ticket path.
- **Follower / people-in-the-loop notices** (`FOLLOWERS_NOTICES`, default OFF): on every create/update, independently of the requester gates above, the ticket's followers (`payload.followers`, agents) and people-in-the-loop (`payload.cc`, external emails) are emailed about the last event, threaded with the `[#shortID]` tag so their replies match back into the ticket. Visibility is unchanged: followers get everything (public messages, private notes, system notes, status changes, assignment changes, follower/loop-list changes); people-in-the-loop get public messages, status changes, and loop-list changes only. Echo control excludes the requester, event author, and `[Relayed from …]` sender for this audience. Every recipient in both notice audiences passes the outbound loop guard. Notice failures are best-effort and never fail the webhook (a non-200 would make Helpdesk redeliver and duplicate email).

> **Webhook double-send caution:** dev and prod share one Helpdesk account, so both apps receive every webhook. `SUBMITTER_REPLIES`, `AGENT_NOTICES`, and `FOLLOWERS_NOTICES` must each be enabled in at most one environment at a time, or recipients are double-emailed.

Webhook endpoint: `/api/helpdesk` (behind APIM), auth via the `subscription-key` query parameter.

---

# Subject Threading & Requester Addresses

**Subject threading (`subject.ts`).** Outbound mail embeds a `[#<shortID>]` tag in the subject. Inbound matching reads that tag first (`extractTicketRef`, last tag wins for forwarded chains) and only falls back to subject-substring comparison when no tag matches. `withTicketRef` strips any existing tags before re-appending, so tags do not accumulate across reply round-trips.

**Requester addresses.** The customer's real email address is stored unaltered as the Helpdesk ticket requester, and mirrored into `customFields.email` — the field the webhook sends agent replies to. This is safe **only because Helpdesk's own requester notifications are disabled in Helpdesk's admin settings** — the relay is the sole sender of customer email (reply-received ack for existing tickets, agent replies via the webhook). **Re-enabling Helpdesk's requester notifications would double-email customers on every event.**

**Transition note (2026-08).** Tickets created before this change carry a hashed requester (`<local>=<domain>@<old sink domain>`, e.g. `john=example.com@…`). Replies to those threads miss the requester-email lookup and open a new ticket (agents merge by hand), and stale hashed **contacts** in Helpdesk's contact database must not be linked to new UI tickets — agent replies to them bounce silently at the dead sink domain until the ticket's `email` custom field is corrected.

---

# SharePoint Attachment Storage

Tenant: [https://corespecialty.sharepoint.com](https://corespecialty.sharepoint.com)

Sites:
- Prod: `/sites/eCommerceAccounts`
- Dev: `/sites/eCommerceAccounts_DEV`

Library: `Document Landing`

Configured via `SPO_SITE_URL` and `SPO_LIBRARY_NAME`.

Folder structure: `"$shortID - $sender"` (one folder per ticket, created at the drive root; reused on a `409` conflict). Folder and file names are sanitized for SharePoint.

Graph authentication uses the Function App's managed identity (`Sites.Selected` model) — see **Graph Identity & Mailbox Setup**. Files are uploaded via a Graph upload session (`createUploadSession` + a single `PUT`).

---

# Mail Flow & Attachment Size Limits

Mail lands **natively** in the shared mailbox; a Graph subscription fires a notification. There is no SendGrid Inbound Parse and no BCC transport rule, so the old 30 MB MIME cap is gone — message size is bounded by Exchange's receive limit (configurable). The relay limit below is the SharePoint-copy decision.

Filtering (ignored — never uploaded or counted toward the total):
- Inline attachments (Graph `isInline`, e.g. signature/logo images).
- Image files under 20 KB.
- Image files with `signature` in the filename.

Size limit:
- `ATTACHMENT_MAX_BYTES` is the **per-file** raw-byte limit (default `100 * 1024 * 1024` = 100 MiB; env-overridable, read once at load). Each file at or under it uploads; files over it are skipped. The outer bound is Exchange's max message size (~150 MB), which caps what reaches the mailbox at all.

Oversize behavior (per file):
- A file over the per-file limit is **not** uploaded, but in-limit files in the same message still upload.
- An agent `System note:` naming the skipped file(s) and their sizes is added to the ticket. The original mail + attachments remain in the mailbox.

Upload mechanics:
- Attachments are listed as metadata first (`$select`, no bytes), so the policy runs without downloading anything; bytes are then fetched **one file at a time** via the `/$value` raw stream (no base64), bounding memory to the largest single file.
- Files ≤ 10 MiB upload with a single content `PUT`; larger files use a Graph **upload session** written in ≤ 10 MiB fragments (Graph rejects fragments over 60 MiB, so big files must be chunked).
- Uploads are per-file: one attachment failing to fetch/upload (e.g. a non-file attachment that 404s on `/$value`) is logged and skipped; its siblings still upload.
- `host.json` tunes the queue so large transfers don't exhaust memory or time out: `functionTimeout` is 10 min and `visibilityTimeout` is set **higher** (15 min) so a slow drain can't have its queue message re-picked by a second worker mid-run and double-process. `batchSize: 1` serializes drains within an instance — both to bound memory (each in-flight message buffers its largest attachment whole, so peak heap ≈ one max-file) and to close the concurrent-duplicate-ticket window. To close that window **across** instances, cap scale-out to a single instance (see the deployment note below); the relay is low-volume, so serial drains are fine. True Graph→SharePoint streaming would remove the memory ceiling if higher concurrency is ever needed.
- **HTTP resilience.** The Graph and Helpdesk axios clients carry a per-request timeout (`GRAPH_HTTP_TIMEOUT_MS` / `HELPDESK_HTTP_TIMEOUT_MS`, default 60 s; attachment transfers use `GRAPH_TRANSFER_TIMEOUT_MS`, default 300 s) so one hung call can't burn the whole invocation, plus a shared retry policy that honors `Retry-After`. Retry safety: `429`/`503` (server rejected before processing) retry for any method; ambiguous `5xx`/transport errors retry **only** for idempotent reads, so a retry never duplicates a ticket or an outbound email. Helpdesk calls are additionally paced at 5 requests/second per Function worker process by default, including retries, and use a Helpdesk-scoped retry ladder of 5 retries with a 60 s maximum delay. The Graph and Storage clients keep the shared retry defaults. Terminal HTTP errors carry an explicit `api` (`Helpdesk`, `Microsoft Graph`, `Azure Blob Storage`, or `Azure Queue Storage`) and completed retry count in structured logs, and the API name prefixes the error message for unstructured/runtime logs.
- **Self-healing + observability.** `sweep-inbox` (timer, default 15 min, `runOnStartup`) enqueues a drain per mailbox regardless of notification delivery, so mail stranded by a delivery outage is always picked up; `renew-subscriptions` is also `runOnStartup` and per-mailbox isolated. Drains that exhaust `maxDequeueCount` dead-letter to `<queue>-poison`, where the `mail-poison` trigger logs them at error severity (queryable/alertable via `traces | where severityLevel >= 3`).
- **Operator-only startup queue cleanup.** `MAIL_QUEUE_CLEAR_ON_STARTUP` defaults to off. When enabled, each Function worker instance clears only `MAIL_QUEUE_NAME` during startup; `<queue>-poison` is preserved. The startup inbox sweep then enqueues fresh mailbox drains, so the queue is reconstructed from current mailbox state. Because app-start hooks run once per instance (including restarts and scale-out), leaving this enabled can delete newly queued work: reset the live app setting to `false` immediately after one verified cleanup (or reset the GitHub variable and redeploy). The clear is one bounded attempt so it stays inside the language-worker startup budget; a timeout fails startup and the next worker start safely tries the idempotent clear again while the switch remains enabled. Other failures also abort startup rather than consuming the stale queue; disabling the switch is the recovery path. Startup messages are app-level `console` logs rather than function-invocation logs. The identity selected by `AzureWebJobsStorage__clientId` (falling back to `MANAGED_IDENTITY_CLIENT_ID`) needs **Storage Queue Data Contributor** on the storage account.
- **Scale-out cap (deployment).** Set the Function App to a single instance so cross-instance drains can't race: `az functionapp update -g <rg> -n <app> --set functionAppScaleLimit=1` (or app setting `WEBSITE_MAX_DYNAMIC_APPLICATION_SCALE_OUT=1`). Timers are already singletons; the queue + sweep keep throughput fine at one instance.

---

# Outbound Email Behavior

Sent via Microsoft Graph `POST /users/{mailbox}/sendMail` from the relevant shared mailbox.

Outbound triggers:
- Acknowledgement on a **reply that updates an existing ticket** (via `process-mail`, requiring `TICKET_CREATE` + `SUBMITTER_REPLIES`). A **new** ticket is opened silently — no "ticket created" notice is sent to the requester.
- Agent replies to the requester, **text only** (via `helpdesk`, gated by `SUBMITTER_REPLIES`).
- Public-message copies to the assigned agent (via `helpdesk`, gated by `AGENT_NOTICES`, including the agent's own Helpdesk-authored replies; same-address relayed email is loop-suppressed).
- Follower / people-in-the-loop notices on ticket events (via `helpdesk`, gated by `FOLLOWERS_NOTICES`).
- Debug message (errors only, when `SEND_DEBUG_EMAIL=true`) — sent from a real shared mailbox.

All relay email is sent from the relevant shared mailbox (the inbox the mail was addressed to / `customFields.inbox`, defaulting to `escape@corespecialty.com`).

---

# Graph Identity & Mailbox Setup

Graph auth is the **Function App's managed identity** — no client secret to store or rotate. The
managed identity is itself a service principal (with its own app id), and all Graph/SharePoint
permissions are granted to it. The same identity resolves the Key Vault references for the
relay's non-Entra secrets (`HELPDESK_PAT`, `GRAPH_SUBSCRIPTION_CLIENT_STATE`).

- **System- vs user-assigned:** a **user-assigned** managed identity is recommended (survives
  Function App re-creation, can be pre-granted, and is selected via `MANAGED_IDENTITY_CLIENT_ID`).
  A system-assigned identity also works (leave `MANAGED_IDENTITY_CLIENT_ID` unset).
- **Local dev fallback:** `func start` has no managed identity, so it uses the developer's
  `az login` (`DefaultAzureCredential`). There is **no client-secret path** — auth is
  secretless everywhere.

**Entra (Graph application permissions on the managed identity, admin-consented):**
- `Mail.ReadWrite` — read inbound messages and move them to the processed folder.
- `Mail.Send` — send acks, requester replies, and agent/follower/cc notices from the shared mailboxes.
- `Sites.Selected` — SharePoint upload.
- `GroupMember.Read.All` — read AAD security-group membership for the `sync-teams` team sync (below). **Note:** the Exchange Application Access Policy scopes only the `Mail.*` roles to specific mailboxes; it does **not** constrain directory reads, so this grants tenant-wide group/user read. It is read-only — the sync's *writes* all go to Helpdesk, never back to the directory.

> Graph app-role assignments to a managed identity must be done via **PowerShell / Graph API**
> (`New-MgServicePrincipalAppRoleAssignment`) — the Entra portal doesn't expose this for MIs.
> Grant the per-site `Sites.Selected` permission to the **MI's** app id, and (below) scope the
> Exchange Application Access Policy to the **MI's** app id.

**Exchange Online (least privilege — mandatory):**
- An **Application Access Policy** (`New-ApplicationAccessPolicy -AppId <managed-identity app id> ... -AccessRight RestrictAccess`) scopes the identity's Mail.* to **only** the helpdesk mailboxes (`escape@`, `escapereferrals@`, `escapeendorsements@`, `ureferrals@`, + the dev mailbox). Without it the identity could read/send as any tenant mailbox.

**Subscriptions:**
- `renew-subscriptions` (timer, every 6 h, **`runOnStartup`** so a restart re-establishes them at once) creates/renews one `created` subscription per mailbox to `/users/{mailbox}/mailFolders('inbox')/messages`, with `notificationUrl = GRAPH_NOTIFICATION_URL`, `clientState = GRAPH_SUBSCRIPTION_CLIENT_STATE`, expiring ~60 h out (Graph's max for messages is ~70 h). Each mailbox is isolated (one failure doesn't block the others); if any failed the timer invocation still throws so it's visible. Trigger it once after first deploy to bootstrap (Graph validates `/api/notify` on creation).
- `sweep-inbox` (timer, `MAIL_SWEEP_CRON`, default 15 min, **`runOnStartup`**) is the delivery-independent safety net: it enqueues a mailbox-only drain item per mailbox so any mail stranded by a notification-delivery outage (lapsed subscription, Graph/WAF outage, a restart past the TTL) is still drained. Cheap when healthy — an empty inbox is a single id-only listing.

**Team sync (AAD security groups → Helpdesk teams/roles):**
- `sync-teams` (timer, `TEAM_SYNC_CRON`, default hourly; **not** `runOnStartup`, since it can delete agents) reconciles Helpdesk **agents** from AAD security groups. Helpdesk has no team-membership resource — a team is a set of agents and membership lives as a `teamIDs` array on each agent — so the sync PATCHes agents. The group→team/role mapping is **hardcoded per environment** in [`src/functions/team-mapping.ts`](src/functions/team-mapping.ts) (`RULES_BY_ENV`) — like `routing.ts`'s `TEAM_BY_INBOX`, so the mapping (incl. the privileged `owner` grant) is reviewed in PRs rather than living in deploy vars. The active table is selected by the **`RELAY_ENVIRONMENT`** app setting (injected from the deploy matrix: `Production` | `Development`), defaulting to the **Development** table when unset/unknown so a misconfigured deploy can never run Production's reconcile. The `Development` table is a **reduced, dev-only rule set** (separate from Production) so the Dev app never mutates Production's teams. Each rule maps an AAD group **object ID** → a Helpdesk **team ID** + **role** (`owner`=Admin / `normal`=Agent / `viewer`); a rule may omit `team` (a role-only group, e.g. Viewers). Each member accumulates the union of roles + teams across their groups; the most-privileged role (`owner > normal > viewer`) is used when inviting.
  - **New member, no agent** → invite via `POST /agents` (status `TEAM_SYNC_INVITE_STATUS`, default `invited`). **In a mapped group** → add that team. **Left a mapped group** → remove that team. **Scope is "mapped teams only"** — an agent's manually-assigned (non-mapped) teams are never touched, and add/remove is strictly per-team (leaving Group A never removes you from Team B).
  - **Decommission (DELETE)** happens only when an agent ends up in **no mapped group AND zero Helpdesk teams** (mapped *and* manual) — i.e. fully orphaned; a member still in any group/team (e.g. a viewer, or someone on another team) is never deleted. With `TEAM_SYNC_CLEANUP_ORPHANS` on (default), this also reaps **pre-existing** zero-team / no-group agents (a true-up), not just ones de-teamed this run. **`TEAM_SYNC_PROTECTED_AGENTS`** emails are never deleted (and left fully untouched rather than stranded) — use it for the account owner / break-glass admins. Orphan cleanup is **suppressed for the whole run if any group read fails** (can't trust "in no group" on incomplete data).
  - **Safety rails:** a group that reads **empty or errors** has its team's removals **suppressed** (can't tell a legit-empty group from a bad read). Total removals per run are capped by `TEAM_SYNC_MAX_REMOVALS` (default 5); over the cap, **all** removals/deletes are skipped that run (logged at ERROR) while adds still apply. Set `TEAM_SYNC_DRY_RUN=true` to log the intended changes without applying — recommended for the first run; then trigger the timer manually to verify.
  - **Email alerts** (engine: [`src/functions/alerts.ts`](src/functions/alerts.ts); routing + team IDs: `team-mapping.ts`; each digest throttled per environment per Eastern day, sent from `ALERT_FROM_MAILBOX`): **out of agent licenses** → the Mgmt. Team, Production only (`seat-alert.ts`); **any other sync failure** (invite rejections, update/delete failures, failed group reads) → Development / IT Support, both environments (`sync-failure-alert.ts`, re-alerts the same day only for a *new* failure mode); **changes applied** (agents invited / team membership changed / agents removed) → IT in both environments plus Mgmt. in Production (`sync-change-alert.ts`, at most one mail per day — later same-day changes are in Application Insights only). Kill switches: `ALERT_ENABLED` (all) and `ALERT_IT_ENABLED` / `ALERT_LICENSING_ENABLED` / `ALERT_CHANGES_ENABLED` (per category), all default on, read per-invocation.

**Storage Queue:** `mail-notifications` on the Function App's storage account (`AzureWebJobsStorage`); failures past `maxDequeueCount` dead-letter to `mail-notifications-poison`, monitored by the `mail-poison` trigger.

**Application Gateway WAF — `/api/notify` must be allow-listed (per environment).** The external APIM (`api.corespecialty.com`) sits behind an App Gateway WAF (`APIM-External-WAFv2`, **Prevention** mode, `Microsoft_DefaultRuleSet 2.1` + `Microsoft_BotManagerRuleSet`). A custom **Allow** rule (`HelpdeskEmailRelay`) lets request URIs containing `email`/`helpdesk` **bypass** the managed rules — and **`notify` must be in that allow list too.** Otherwise Graph's change-notification POSTs (JSON body, **no `User-Agent` header**, Microsoft IPs) accumulate a managed-rule anomaly score — `920320` missing-User-Agent + `300100` UnknownBots + `99031001` SQLi-false-positive on the JSON → **blocked by `949110`** — and never reach `notify`. The empty-body **validation handshake survives**, so the subscription **creates, validates, and renews normally but silently never delivers** a notification. Tell-tale symptom: `notify` logs only validation handshakes, no `process-mail`, and `GET /subscriptions` looks healthy. The relay itself is unaffected — a notification POSTed straight to `/api/notify` is processed fine; the block is purely the WAF.

---

# Helpdesk Integration

API version: 1.0.0

Authentication: `HELPDESK_PAT` (Key Vault reference).

Service behavior: creates tickets; updates tickets (public comments only); no status changes; no private notes.

Webhook registration must include `tickets.create` and `tickets.update`.

Configured Webhooks:

```
ID                                   Name                            Url                                                                                                      EventType
--                                   ----                            ---                                                                                                      ---------
2bd9eb52-5c21-4650-aabc-f391acecd35f corespecialty-ticket-create     https://api.corespecialty.com/hdrelay/api/helpdesk?subscription-key=    tickets.create
19cccd62-abb0-48fc-a996-a7c63ce4bb18 corespecialty-ticket-create2    https://api.corespecialty.com/hdrelay-dev/api/helpdesk?subscription-key= tickets.create
a4301167-ec24-46c0-98ae-ea3299a60d07 corespecialty-ticket-update     https://api.corespecialty.com/hdrelay/api/helpdesk?subscription-key=     tickets.update
4a7d4971-1bf8-49ba-93f7-dfd71b2cd885 corespecialty-ticket-update-dev https://api.corespecialty.com/hdrelay-dev/api/helpdesk?subscription-key= tickets.update
```

> Security note: the `subscription-key` values above are also present in this repo's git history. Rotating the APIM subscription keys (and then scrubbing them) is a tracked, still-open follow-up.

---

# Configuration

## Environment Variables

The five mail-integration switches below are independent, default OFF, and read per invocation.
For each, `true`/`on`/`1`/`yes` (case-insensitive) means ON; unset, empty, or any other value means OFF.

| Variable | Description |
|-----------|-------------|
| `ATTACHMENT_MAX_BYTES` | Per-file attachment size limit in bytes (default `100 * 1024 * 1024` = 100 MiB). |
| `GRAPH_BASE_URL` | Microsoft Graph base URL (e.g. `https://graph.microsoft.com/v1.0`). |
| `MANAGED_IDENTITY_CLIENT_ID` | User-assigned managed identity client ID (omit for system-assigned). Primary Graph auth. |
| `GRAPH_CLIENT_ID` | Graph **app-registration** client ID — the principal the UAMI federates (legacy: `SPO_CLIENT_ID`). Required in Azure. |
| `GRAPH_TENANT_ID` | Tenant ID for Graph auth (legacy: `SPO_TENANT_ID`). |
| `GRAPH_NOTIFICATION_URL` | Public APIM URL of `notify`, **including** the `subscription-key` query param. Used when creating subscriptions. |
| `GRAPH_SUBSCRIPTION_CLIENT_STATE` | Secret validated on each notification (Key Vault reference). |
| `MAILBOX_ADDRESSES` | Comma-separated shared mailboxes to subscribe. |
| `MAIL_PROCESSED_FOLDER` | Folder handled mail is moved to (default `HelpdeskProcessed`). |
| `MAIL_REPROCESS_FOLDER` | Folder scanned whenever drain or ticket creation is active (default `Reprocess`, created on demand). Replays each message individually, bypasses `MAIL_IGNORE_BEFORE`, and sends no requester ack. Drain off + ticketing on leaves a handled replay in this folder with a claim; later drain-on catch-up moves it without repeating ticket work. |
| `MAIL_QUEUE_NAME` | Storage queue name (default `mail-notifications`). |
| `MAIL_QUEUE_CLEAR_ON_STARTUP` | **Operator recovery switch; default OFF.** When enabled, every worker-instance startup clears only `MAIL_QUEUE_NAME` (never `<queue>-poison`) before normal processing. Set the live app setting back to `false` immediately after the stale backlog is cleared (or reset the GitHub variable and redeploy); `sweep-inbox` reseeds fresh mailbox drains on startup. A clear failure aborts startup. Requires **Storage Queue Data Contributor** for the identity selected by `AzureWebJobsStorage__clientId` (falling back to `MANAGED_IDENTITY_CLIENT_ID`). |
| `MAIL_DRAIN_BATCH_SIZE` | Max actionable messages handled across Inbox + Reprocess per `process-mail` invocation (default `10`). Listings follow up to 10 Graph pages and skip claimed mail before applying this cap; a continuation is queued only when eligible work remains within that bounded scan. Page-budget truncation is logged. |
| `MAIL_CLAIM_CONTAINER` | Blob container for drain-off per-message idempotency claims (default `relay-state`). Uses the `AzureWebJobsStorage` account and UAMI; no additional RBAC beyond the existing Blob Data Contributor access. |
| `MAIL_IGNORE_BEFORE` | Cutoff instant — earlier inbox mail is excluded from listings; a triggering id may be fetched only to apply the cutoff guard, after which it is never ticketed, acknowledged, claimed, or moved. Default/fallback `2026-06-19T22:00:00Z`; missing, empty, or unparseable values keep that default. Use an ISO-8601 UTC value such as `2026-09-01T13:00:00Z`. This deploy-managed variable must be set **per GitHub environment** (`Production` and `Development` need independent values), never as one shared repository value. Set Production to the actual go-live instant before enabling drain/ticketing there. Read once at module load, so a settings change/redeploy restart applies it rather than a hot per-invocation flip. |
| `RELAY_IN_SCOPE_DOMAINS` | Comma-separated company domains used to recognize a drain mailbox addressed under an **alias domain** (loop guard): an outbound recipient is suppressed only if its local part matches a `MAILBOX_ADDRESSES` mailbox **and** its domain is one of these. Does not blanket-block the domain — internal senders still get replies. Default `corespecialty.com,corespecialtyins.com`. |
| `GRAPH_HTTP_TIMEOUT_MS` | Per-request timeout for normal Graph calls (default `60000`). |
| `GRAPH_TRANSFER_TIMEOUT_MS` | Per-request timeout for attachment download/upload transfers (default `300000`). |
| `HELPDESK_HTTP_TIMEOUT_MS` | Per-request timeout for Helpdesk calls (default `60000`). |
| `HELPDESK_RATE_LIMIT_RPS` | Helpdesk dispatch rate per Function worker process (default `5` requests/second). This is not coordinated across processes or instances and applies to retries too; values above `1000` disable pacing. |
| `HELPDESK_RETRY_MAX_RETRIES` | Maximum Helpdesk retries after the initial attempt (default `5`). |
| `HELPDESK_RETRY_MAX_DELAY_MS` | Maximum Helpdesk retry delay, including the `Retry-After` clamp (default `60000`). |
| `SPO_SITE_URL` | Full SharePoint site URL. |
| `SPO_LIBRARY_NAME` | Target document library name. |
| `HELPDESK_PAT` | Helpdesk Personal Access Token (Key Vault reference). |
| `HELPDESK_BASE_URL` | Helpdesk API base URL (defaults to `https://api.helpdesk.com/v1`). |
| `DEBUG_EMAIL_TO` | Debug email recipients. |
| `SEND_DEBUG_EMAIL` | Set to `true` to send the debug email on errors. Unset/empty = off. |
| `MAILBOX_DRAIN` | **Move handled mail. Default OFF.** When on, handled messages move to `MAIL_PROCESSED_FOLDER`; previously claimed messages are catch-up moved without repeated ticket/ack activity. When off, messages stay unread and unmoved. If ticketing is on, the worker still locks, lists, fetches, performs ticket work, and writes an idempotency claim. Only the both-off combination returns before all mailbox/storage work. |
| `TICKET_CREATE` | **Inbound ticket processing. Default OFF.** When on, messages find/create/append Helpdesk tickets, upload attachment links, and add oversize notes regardless of drain mode. When off, no inbound Helpdesk reads/writes occur; drain on still moves mail without a ticket by design, while both off does nothing. |
| `SUBMITTER_REPLIES` | **Submitter-facing email. Default OFF.** Enables webhook delivery of agent replies to the requester and the inbound reply-received acknowledgement after an append. Acks also require `TICKET_CREATE` and remain suppressed for Reprocess/relayed threads. |
| `AGENT_NOTICES` | **Assigned-agent public-message copies. Default OFF.** The assigned agent gets public messages, including their own Helpdesk-authored reply. No private/system notes/non-message changes, and no copy back to the same relayed-from email sender (loop guard). |
| `FOLLOWERS_NOTICES` | **Follower / people-in-the-loop notices + non-requester reply threading. Default OFF.** Webhook notices keep the existing follower/cc visibility and echo controls. Tagged non-requester threading additionally requires `TICKET_CREATE` and works in either drain mode; with ticket creation off, no by-reference lookup runs. |
| `USERMGMT_TOGGLE` | **Master switch for `sync-teams` user/team management. Default OFF** (unset/empty = off). `true`/`on`/`1`/`yes` = on. When off, no agent invite/update/delete is attempted; the next enabled run reconciles from live state. |
| `SUBSCRIPTION_RENEW_CRON` | Optional override for the renewal timer (default `0 0 */6 * * *`). |
| `MAIL_SWEEP_CRON` | Optional override for the safety-net sweep timer (default `0 */15 * * * *`, every 15 min). |
| `RELAY_ENVIRONMENT` | Selects the team-sync mapping table in `team-mapping.ts` (`Production` \| `Development`). Injected from the deploy matrix; defaults to the Development table when unset. |
| `TEAM_SYNC_CRON` | Optional override for the team-sync timer (default `0 0 * * * *`, hourly). The group→team/role map itself is hardcoded per-environment in `src/functions/team-mapping.ts`, not an env var. |
| `TEAM_SYNC_CLEANUP_ORPHANS` | `true` (default) reaps pre-existing agents in no mapped group with zero teams; set `false` to only delete agents de-teamed this run. |
| `TEAM_SYNC_PROTECTED_AGENTS` | Comma-separated emails the sync will never delete (owner / break-glass admins). |
| `TEAM_SYNC_MAX_REMOVALS` | Max team removals/deletes applied per run before all removals are skipped that run (default `5`). |
| `TEAM_SYNC_DEFAULT_ROLE` | Role used when a rule omits `role` (default `normal`). |
| `TEAM_SYNC_INVITE_STATUS` | Status for newly invited agents (default `invited`). |
| `TEAM_SYNC_DRY_RUN` | Set to `true` to log intended team-sync changes without applying them. Recommended for the first run. |
| `ALERT_ENABLED` | Master switch for the relay's email alerts (default on). `false` silences every alert; the conditions are still logged at ERROR. |
| `ALERT_IT_ENABLED` / `ALERT_LICENSING_ENABLED` / `ALERT_CHANGES_ENABLED` | Per-category alert switches (default on): sync failures / out-of-licenses / applied agent+team changes. Read per-invocation, so they flip via an app setting with no redeploy. |
| `ALERT_FROM_MAILBOX` | Mailbox alerts are sent as (default `escape@corespecialty.com`; must be licensed by the Application Access Policy). |
| `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` / `AZURE_FUNC_APP_SUBSCRIPTION` / `AZURE_FUNCTION_NAME` | Deployment/auth tooling. |

Key Vault-linked: `GRAPH_SUBSCRIPTION_CLIENT_STATE`, `HELPDESK_PAT` (resolved by the managed identity). No Graph client secret is used anywhere — auth is the app registration federated by the user-assigned managed identity.

> **Webhook double-send caution:** because dev and prod both receive the shared Helpdesk account's webhooks, each webhook-driven toggle (`SUBMITTER_REPLIES`, `AGENT_NOTICES`, `FOLLOWERS_NOTICES`) must be on in at most one environment at a time.

`Deploy.yml` maps non-secret app settings from matching GitHub `vars.*` names. This repository currently has no GitHub environments/variables configured, so the live toggles are managed directly as Function App portal settings. After any deploy, re-verify all five values on the target app (or configure matching GitHub variables before deploying). `MAIL_IGNORE_BEFORE` is also deploy-managed now, but unlike the toggles it must be an **environment-scoped** variable: Development and Production require independent cutoffs, and a future Production go-live value applied to Development would silently exclude current test mail. `MAIL_QUEUE_CLEAR_ON_STARTUP` is deploy-mapped as well; scope it to only the environment being cleaned and reset it to `false` after the first verified purge so later restarts cannot discard fresh queue work.

---

# Local Development

Prerequisites: Node 24.x, Azure Functions Core Tools v4.

```bash
npm ci
npm run build
func start
```

TypeScript output directory: `/build` (git-ignored; CI rebuilds it). `local.settings.json` mirrors production environment variables (not committed). HTTP + queue + timer triggers; local queue runs against the configured `AzureWebJobsStorage`.

---

# Testing

**Jest + ts-jest**. Tests live next to the source as `src/functions/*.test.ts`, compile through `tsconfig.test.json` (CommonJS), and are excluded from the app build.

```bash
npm test            # run the full suite
npm run test:watch  # watch mode
npm run test:coverage
```

| Test file | Focus |
|-----------|-------|
| `subject.test.ts` | `[#shortID]` tag extraction / strip-and-append / normalization |
| `routing.test.ts` | inbox normalization, team routing, inbound loop guard |
| `rate-limit.test.ts` | fixed-interval slot reservation, concurrency, interceptor pacing, and retry re-entry |
| `clear-mail-queue.test.ts` | startup purge gate, primary-queue targeting, storage identity configuration, and failure logging |
| `helpdesk-client.test.ts` | `findTicketByShortId`: shortID param + client-side verification, 4xx→null / 5xx→throw |
| `templates.test.ts` | auto-reply / agent-reply / notice email builders, relayed-from marker round-trip |
| `ticket-notices.test.ts` | follower/cc + assigned-agent audiences: visibility, include-own agent replies, echo control, shared lookup, dedupe, isolation |
| `graph-mail.test.ts` | mail parsing/transfers plus bounded oldest-first folder pagination, nextLink/filter preservation |
| `mail-claims.test.ts` | case-preserving claim names and create-once blob exists/claim/release behavior |
| `sharepoint.test.ts` | `sanitizeSharePointName` |
| `sharepoint.e2e.test.ts` | Graph pipeline: credential selection, site + drive resolution, folder create / `409` reuse, small content PUT + chunked session, multi-file orchestration |
| `process-mail.helpers.test.ts` | attachment per-file policy, body formatting, queue-item parsing |
| `process-mail.handler.test.ts` | Inbound workflow E2E: move-only drain semantics, claim/move idempotency, continuation/cutoff gates, threading, ticket paths, attachments |
| `notify.test.ts` | validationToken handshake, clientState reject, resource parse + enqueue |
| `helpdesk.handler.test.ts` | Webhook workflow E2E: three-audience toggle matrix, create patch, requester gates, notice-pass wiring |

Mocking: `@azure/functions` is mocked to a no-op registry (`app.http` / `app.storageQueue` / `app.timer` / `output.storageQueue`). Graph / Helpdesk HTTP is intercepted with `axios-mock-adapter`, or `./graph-mail` / `./sharepoint` are mocked at the boundary. `@azure/identity` `getToken` is mocked for the SharePoint Graph tests.

---

# CI/CD

Workflow: `.github/workflows/Deploy.yml`. Build artifact → zip package → Run From Package. The workflow maps non-secret app settings from `vars.*`, though this repo currently has no GitHub variables configured and live values are portal-managed (re-verify them after a deploy). Configure `MAIL_IGNORE_BEFORE` separately in each GitHub environment before relying on deploy-managed settings. Secrets (`HELPDESK_PAT`, `GRAPH_SUBSCRIPTION_CLIENT_STATE`) are uploaded to Key Vault and referenced. Graph auth is the managed identity (no Graph client secret deployed). Ingress: Azure API Management.

> The pipeline does not yet run `npm test` as a gate.

---

# Observability

Application Insights is enabled. Primary runtime troubleshooting: Azure Portal → Function App → Log Stream.

Required roles: Contributor on subscription; PIM activation for Tenant Root Reader.
