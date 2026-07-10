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
    process-mail.ts        # Queue fn: dequeue -> create/update Helpdesk ticket + SharePoint + ack
    helpdesk.ts            # HTTP fn:  Helpdesk webhook -> outbound email on agent replies (Graph sendMail)
    renew-subscriptions.ts # Timer fn: create/renew Graph mailbox subscriptions (runOnStartup)
    sweep-inbox.ts         # Timer fn: safety-net — enqueue a drain per mailbox (runOnStartup)
    mail-poison.ts         # Queue fn: log dead-lettered drains at error severity (alertable)
    graph-client.ts        # Shared app-only Graph token + axios client (timeouts + retry)
    http-retry.ts          # Shared axios retry policy (429/503 + idempotent-only 5xx)
    graph-mail.ts          # Graph mail I/O (read message/attachments, sendMail, move, builders)
    sharepoint.ts          # Graph upload helpers (site/drive/folder; content PUT or chunked session)
    helpdesk-client.ts     # Helpdesk REST client + ticket operations
    requester-hash.ts      # Requester hash encode/decode round-trip
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
             → GET message + attachments (Graph)
             → find / create Helpdesk ticket
             → upload attachments to SharePoint
             → sendMail acknowledgement (from the shared mailbox)
             → move message to "HelpdeskProcessed" (idempotency)
```

1. **`notify`** receives the Graph notification at `/api/notify` (through APIM). It:
   - Answers the subscription validation handshake (echoes `validationToken` as `text/plain`).
   - Verifies `clientState` against `GRAPH_SUBSCRIPTION_CLIENT_STATE`.
   - Enqueues `{ mailbox, messageId }` onto the `mail-notifications` Storage Queue and returns `202` (Graph requires an ack within ~3 s).

2. **`process-mail`** (queue trigger) does the work:
   - **Drains the whole inbox**, not just the notified message: it lists every message currently in the inbox and runs the steps below on each. Anything whose notification was dropped (e.g. mail that arrived during an app reboot) is swept up by the next notification's drain. Large backlogs are drained across several short invocations — capped at `MAIL_DRAIN_BATCH_SIZE` per run (default 10), with a self-terminating continuation drain re-enqueued when a full page is seen.
   - **Ignores mail received before `MAIL_IGNORE_BEFORE`** (default the go-live boundary): the listing is filtered server-side (`receivedDateTime ge …`) so the pre-go-live backlog is never even fetched — it stays untouched in the inbox rather than being ticketed/auto-replied. (Without this, the oldest-first drain would process that backlog first.) A per-message guard backstops the always-included triggering id.
   - **Replays the `MAIL_REPROCESS_FOLDER`** (default `Reprocess`, created on demand): every drain also scans this folder — drop a message into it (e.g. one that arrived during an outage or was filed too soon) and the next drain replays it through the full pipeline **as if it just arrived**. Reprocess intentionally **bypasses the `MAIL_IGNORE_BEFORE` cutoff** and **sends no customer auto-reply** (it only creates/updates the ticket); the message is then moved to `MAIL_PROCESSED_FOLDER` like normal mail. Pickup latency is one sweep cycle (`MAIL_SWEEP_CRON`, ≤15 min by default) since moving mail into a folder raises no inbox notification.
   - Fetches the message (plain-text body via `Prefer: outlook.body-content-type="text"`) and its attachments via Graph.
   - Ignores loop/system senders (the hash domain, `helpdesk.com`, the `onmicrosoft.com` tenant).
   - **Never dispatches to one of our own drain mailboxes**: any outbound (ack or agent reply) addressed to a `MAILBOX_ADDRESSES` mailbox — by exact match, *or* the same mailbox under an alias company domain (`corespecialty.com` / `corespecialtyins.com`, set by `RELAY_IN_SCOPE_DOMAINS`), e.g. `escape@corespecialty.com` for a configured `escape@corespecialtyins.com` — is suppressed, otherwise it would land back in a drained inbox, open a fresh ticket, and ping-pong. This is scoped to the drain mailboxes (and their alias-domain spellings), **not** the whole company domain, so ordinary internal requesters still get replies. (Outbound counterpart to the ignored-sender guard.)
   - Looks up the requester's existing tickets and either **updates** a matched ticket or **creates** a new one.
   - Uploads attachments to SharePoint when the combined size is within the limit (see size policy).
   - Sends a reply-received acknowledgement **only when an inbound updates an existing ticket** — **from the receiving shared mailbox**. A **new** ticket is opened **silently**: no "ticket has been created" notice is sent to the requester, from the relay or from Helpdesk (Helpdesk's own notice is dead-ended by the hashed requester sink).
   - When attachments exceed the combined limit: uploads nothing and adds an agent `System note:` describing the overage (the original mail + attachments stay in the mailbox).
   - Sends a debug email on **errors only** (when `SEND_DEBUG_EMAIL=true`).
   - Moves the source message to `MAIL_PROCESSED_FOLDER` so a duplicate notification (whose original message id now 404s) is a no-op. Processing is at-least-once: steps **after the ticket is created/updated** (and the reply ack, when one is sent) are best-effort so a late failure can't trigger a reprocess that duplicates the ticket or re-acks.

Ticket matching prefers the `[#shortID]` threading tag in the subject, then falls back to a guarded subject-substring match (an empty ticket subject never matches). See **Subject Threading & Requester Encoding**.

Auth: the function key / APIM `subscription-key` is carried in the query string of `GRAPH_NOTIFICATION_URL` (Graph calls the exact URL, and appends `&validationToken=...` on validation). Treat the full notification URL (with key) as a secret.

---

## Helpdesk Webhook Flow

```
Helpdesk → APIM → helpdesk function → Graph sendMail (from the shared mailbox)
```

Registered webhook events: `tickets.create`, `tickets.update`.

The `helpdesk` function:
- On `tickets.create` from the Helpdesk UI: patches `customFields.email` with the decoded requester address, and emails the requester **only when the create's last event is agent-authored**. Customer-emails-in (client-authored) are already handled by `process-mail`, so they are **not echoed back**.
- On `tickets.update`: emails the requester when the last event is **agent-authored**, not sourced from email, not a private message, and not a `System note:`.
- Sends the agent's reply **text only** (Graph `sendMail`) — attachments are not forwarded to the requester.
- Does not update ticket status; does not create private notes.

Webhook endpoint: `/api/helpdesk` (behind APIM), auth via the `subscription-key` query parameter.

---

# Subject Threading & Requester Encoding

**Subject threading (`subject.ts`).** Outbound mail embeds a `[#<shortID>]` tag in the subject. Inbound matching reads that tag first (`extractTicketRef`, last tag wins for forwarded chains) and only falls back to subject-substring comparison when no tag matches. `withTicketRef` strips any existing tags before re-appending, so tags do not accumulate across reply round-trips.

**Requester encoding.** Helpdesk stores the requester as an inbound-hashed address so Helpdesk's own notifications never reach the customer directly — the relay is the sole outbound path. The encoding is reversible and subdomain-safe: the single `@` becomes `=` —
`john@sub.example.com` → `john=sub.example.com@<RELAY_HASH_DOMAIN>`.
`decodeRequesterEmail` reverses it on the last `=` (with a legacy `.`-form fallback for older tickets) and passes through any address not under the hash domain. **Keep `RELAY_HASH_DOMAIN`'s value stable** so already-created tickets keep decoding; the domain should be one with no real mailbox so Helpdesk mail to it goes nowhere.

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
- **HTTP resilience.** The Graph and Helpdesk axios clients carry a per-request timeout (`GRAPH_HTTP_TIMEOUT_MS` / `HELPDESK_HTTP_TIMEOUT_MS`, default 60 s; attachment transfers use `GRAPH_TRANSFER_TIMEOUT_MS`, default 300 s) so one hung call can't burn the whole invocation, plus a shared retry policy that honors `Retry-After`. Retry safety: `429`/`503` (server rejected before processing) retry for any method; ambiguous `5xx`/transport errors retry **only** for idempotent reads, so a retry never duplicates a ticket or an outbound email.
- **Self-healing + observability.** `sweep-inbox` (timer, default 15 min, `runOnStartup`) enqueues a drain per mailbox regardless of notification delivery, so mail stranded by a delivery outage is always picked up; `renew-subscriptions` is also `runOnStartup` and per-mailbox isolated. Drains that exhaust `maxDequeueCount` dead-letter to `<queue>-poison`, where the `mail-poison` trigger logs them at error severity (queryable/alertable via `traces | where severityLevel >= 3`).
- **Scale-out cap (deployment).** Set the Function App to a single instance so cross-instance drains can't race: `az functionapp update -g <rg> -n <app> --set functionAppScaleLimit=1` (or app setting `WEBSITE_MAX_DYNAMIC_APPLICATION_SCALE_OUT=1`). Timers are already singletons; the queue + sweep keep throughput fine at one instance.

---

# Outbound Email Behavior

Sent via Microsoft Graph `POST /users/{mailbox}/sendMail` from the relevant shared mailbox.

Outbound triggers:
- Acknowledgement on a **reply that updates an existing ticket** (via `process-mail`). A **new** ticket is opened silently — no "ticket created" notice is sent to the requester.
- Agent replies, **text only** (via `helpdesk`).
- Debug message (errors only, when `SEND_DEBUG_EMAIL=true`) — sent from a real shared mailbox.

Acknowledgement / agent-reply `from` is the shared mailbox itself (the inbox the mail was addressed to / `customFields.inbox`, defaulting to `escape@corespecialty.com`).

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
- `Mail.Send` — send acks / agent replies from the shared mailboxes.
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
  - **New member, no agent** → invite via `POST /agents` (Helpdesk creates them `invited` and mails the invite; the create schema rejects an explicit `status`). **In a mapped group** → add that team. **Left a mapped group** → remove that team. **Scope is "mapped teams only"** — an agent's manually-assigned (non-mapped) teams are never touched, and add/remove is strictly per-team (leaving Group A never removes you from Team B).
  - **Decommission (DELETE)** happens only when an agent ends up in **no mapped group AND zero Helpdesk teams** (mapped *and* manual) — i.e. fully orphaned; a member still in any group/team (e.g. a viewer, or someone on another team) is never deleted. With `TEAM_SYNC_CLEANUP_ORPHANS` on (default), this also reaps **pre-existing** zero-team / no-group agents (a true-up), not just ones de-teamed this run. **`TEAM_SYNC_PROTECTED_AGENTS`** emails are never deleted (and left fully untouched rather than stranded) — use it for the account owner / break-glass admins. Orphan cleanup is **suppressed for the whole run if any group read fails** (can't trust "in no group" on incomplete data).
  - **Safety rails:** a group that reads **empty or errors** has its team's removals **suppressed** (can't tell a legit-empty group from a bad read). Total removals per run are capped by `TEAM_SYNC_MAX_REMOVALS` (default 5); over the cap, **all** removals/deletes are skipped that run (logged at ERROR) while adds still apply. Set `TEAM_SYNC_DRY_RUN=true` to log the intended changes without applying — recommended for the first run; then trigger the timer manually to verify.
  - **Out of agent licenses → the Management team is emailed, once a day** ([`src/functions/seat-alert.ts`](src/functions/seat-alert.ts)). Helpdesk exposes no seat/quota endpoint, so the relay only discovers a full account by trying: `POST /agents` returns `409 {"error":{"type":"limitExceeded","message":"agents count (15) is greater than subscription allows (14)","details":{"lackingSeats":1}}}`. That's a business condition only a licence purchase fixes, so the sync mails the **Helpdesk Management team's agents** (`MANAGEMENT_TEAM_BY_ENV` in `team-mapping.ts`) from the **Escape mailbox**, naming every blocked user and the seat shortfall. It is **throttled to one mail per environment per Eastern day** by a create-once blob (`If-None-Match: *`) in the `relay-state` container — atomic, so it holds across instances — because the sync retries hourly and would otherwise mail management every hour until seats are bought. Detection keys on the error **`type`**, not the 409 status (`POST /agents` also 409s on a duplicate email). The alert is best-effort: it never changes the sync's own outcome, and the invite failures still fail the run. **Only Production maps a management team** — Development sends no mail (it shares the Helpdesk account with Production, so a Dev-mapped team would mail Production's managers); the seat-limit condition is logged at ERROR regardless. If every send fails the day's claim is released so the next hourly run retries. Set `SEAT_ALERT_ENABLED=false` to silence the mail without a redeploy.

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
2bd9eb52-5c21-4650-aabc-f391acecd35f corespecialty-ticket-create     https://api.corespecialty.com/hdrelay/api/helpdesk?subscription-key=cf4cd128142642558f4dd1fbd41fda12     tickets.create
19cccd62-abb0-48fc-a996-a7c63ce4bb18 corespecialty-ticket-create2    https://api.corespecialty.com/hdrelay-dev/api/helpdesk?subscription-key=285d5e3e75fa42929a0c11c90681d1b9 tickets.create
a4301167-ec24-46c0-98ae-ea3299a60d07 corespecialty-ticket-update     https://api.corespecialty.com/hdrelay/api/helpdesk?subscription-key=cf4cd128142642558f4dd1fbd41fda12     tickets.update
4a7d4971-1bf8-49ba-93f7-dfd71b2cd885 corespecialty-ticket-update-dev https://api.corespecialty.com/hdrelay-dev/api/helpdesk?subscription-key=285d5e3e75fa42929a0c11c90681d1b9 tickets.update
```

> Security note: the `subscription-key` values above are also present in this repo's git history. Rotating the APIM subscription keys (and then scrubbing them) is a tracked, still-open follow-up.

---

# Configuration

## Environment Variables

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
| `MAIL_REPROCESS_FOLDER` | Folder scanned on every drain whose messages are replayed through the inbound pipeline as if newly arrived (default `Reprocess`, created on demand). Bypasses `MAIL_IGNORE_BEFORE` and sends no customer auto-reply; handled messages move to `MAIL_PROCESSED_FOLDER`. **Each message is replayed individually**, so dragging a whole Outlook *conversation* in moves every email in the thread and creates one ticket per email — drag a single message to reprocess a thread as one ticket. |
| `MAIL_QUEUE_NAME` | Storage queue name (default `mail-notifications`). |
| `MAIL_DRAIN_BATCH_SIZE` | Max inbox messages drained per `process-mail` invocation (default `10`); a full page re-enqueues a continuation drain. |
| `MAIL_IGNORE_BEFORE` | Cutoff instant — mail **received before** it is ignored (never ticketed/auto-replied, left untouched in the inbox). Skips the pre-go-live backlog, which the oldest-first drain would otherwise process first. Default `2026-06-19T22:00:00Z` (2026-06-19 6:00 PM US Eastern / EDT). Any `Date`-parseable value; ISO-8601 with a `Z`/offset is safest. Enforced server-side via a `receivedDateTime ge` filter on the inbox listing **and** a per-message guard. |
| `RELAY_IN_SCOPE_DOMAINS` | Comma-separated company domains used to recognize a drain mailbox addressed under an **alias domain** (loop guard): an outbound recipient is suppressed only if its local part matches a `MAILBOX_ADDRESSES` mailbox **and** its domain is one of these. Does not blanket-block the domain — internal senders still get replies. Default `corespecialty.com,corespecialtyins.com`. |
| `GRAPH_HTTP_TIMEOUT_MS` | Per-request timeout for normal Graph calls (default `60000`). |
| `GRAPH_TRANSFER_TIMEOUT_MS` | Per-request timeout for attachment download/upload transfers (default `300000`). |
| `HELPDESK_HTTP_TIMEOUT_MS` | Per-request timeout for Helpdesk calls (default `60000`). |
| `RELAY_HASH_DOMAIN` | Requester-hash sink domain + loop guard. **Required** (no built-in default; the relay throws without it). |
| `SPO_SITE_URL` | Full SharePoint site URL. |
| `SPO_LIBRARY_NAME` | Target document library name. |
| `HELPDESK_PAT` | Helpdesk Personal Access Token (Key Vault reference). |
| `HELPDESK_BASE_URL` | Helpdesk API base URL (defaults to `https://api.helpdesk.com/v1`). |
| `DEBUG_EMAIL_TO` | Debug email recipients. |
| `SEND_DEBUG_EMAIL` | Set to `true` to send the debug email on errors. Unset/empty = off. |
| `TICKETING_TOGGLE` | **Master switch for all mail-flow interaction. Default OFF** (unset/empty = off). `true`/`on`/`1`/`yes` = on. When off, `process-mail` and the `helpdesk` webhook do nothing — no ticket create/update, no outbound email — and mail is left untouched in the mailbox (caught up on the next drain once re-enabled). Subscription renewal + inbox sweep keep running. |
| `USERMGMT_TOGGLE` | **Master switch for `sync-teams` user/team management. Default OFF** (unset/empty = off). `true`/`on`/`1`/`yes` = on. When off, no agent invite/update/delete is attempted; the next enabled run reconciles from live state. |
| `SUBSCRIPTION_RENEW_CRON` | Optional override for the renewal timer (default `0 0 */6 * * *`). |
| `MAIL_SWEEP_CRON` | Optional override for the safety-net sweep timer (default `0 */15 * * * *`, every 15 min). |
| `RELAY_ENVIRONMENT` | Selects the team-sync mapping table in `team-mapping.ts` (`Production` \| `Development`). Injected from the deploy matrix; defaults to the Development table when unset. |
| `TEAM_SYNC_CRON` | Optional override for the team-sync timer (default `0 0 * * * *`, hourly). The group→team/role map itself is hardcoded per-environment in `src/functions/team-mapping.ts`, not an env var. |
| `TEAM_SYNC_CLEANUP_ORPHANS` | `true` (default) reaps pre-existing agents in no mapped group with zero teams; set `false` to only delete agents de-teamed this run. |
| `TEAM_SYNC_PROTECTED_AGENTS` | Comma-separated emails the sync will never delete (owner / break-glass admins). |
| `TEAM_SYNC_MAX_REMOVALS` | Max team removals/deletes applied per run before all removals are skipped that run (default `5`). |
| `TEAM_SYNC_DEFAULT_ROLE` | Role used when a rule omits `role` (default `normal`). |
| `TEAM_SYNC_DRY_RUN` | Set to `true` to log intended team-sync changes without applying them. Recommended for the first run. |
| `SEAT_ALERT_ENABLED` | Set to `false` to stop emailing the Management team when Helpdesk runs out of agent licenses (default on; the condition is still logged at ERROR). |
| `SEAT_ALERT_FROM_MAILBOX` | Shared mailbox the seat-limit alert is sent as (default `escape@corespecialty.com`). Must be covered by the Exchange Application Access Policy. |
| `SEAT_ALERT_CONTAINER` | Blob container holding the once-per-day alert claim (default `relay-state`, on the `AzureWebJobsStorage` account). |
| `SEAT_ALERT_TIME_ZONE` | IANA zone defining the alert's "day" (default `America/New_York`, so the daily reset matches the business day rather than 8 PM ET). |
| `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` / `AZURE_FUNC_APP_SUBSCRIPTION` / `AZURE_FUNCTION_NAME` | Deployment/auth tooling. |

Key Vault-linked: `GRAPH_SUBSCRIPTION_CLIENT_STATE`, `HELPDESK_PAT` (resolved by the managed identity). No Graph client secret is used anywhere — auth is the app registration federated by the user-assigned managed identity.

App-setting values (non-secret) are supplied at deploy time from `Deploy.yml` (`vars.*`).

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
| `requester-hash.roundtrip.test.ts` | `toInboundHashedEmail` ↔ `decodeRequesterEmail` round-trip |
| `routing.test.ts` | inbox normalization, team routing, inbound loop guard |
| `helpdesk-client.test.ts` | client base URL/auth, ticket op body shapes, `findExistingTicket` matching |
| `graph-mail.test.ts` | `parseGraphMessage`, `listMessageAttachments`/`fetchAttachmentBytes`, `sendMailViaGraph` shape, oversize builder |
| `sharepoint.test.ts` | `sanitizeSharePointName` |
| `sharepoint.e2e.test.ts` | Graph pipeline: credential selection, site + drive resolution, folder create / `409` reuse, small content PUT + chunked session, multi-file orchestration |
| `process-mail.helpers.test.ts` | attachment per-file policy, body formatting, queue-item parsing |
| `process-mail.handler.test.ts` | Inbound workflow E2E: ignored sender, new + existing ticket, per-file oversize, multi-attachment upload, idempotency move |
| `notify.test.ts` | validationToken handshake, clientState reject, resource parse + enqueue |
| `helpdesk.handler.test.ts` | Webhook workflow E2E: create-branch echo suppression, agent-reply email gates |

Mocking: `@azure/functions` is mocked to a no-op registry (`app.http` / `app.storageQueue` / `app.timer` / `output.storageQueue`). Graph / Helpdesk HTTP is intercepted with `axios-mock-adapter`, or `./graph-mail` / `./sharepoint` are mocked at the boundary. `@azure/identity` `getToken` is mocked for the SharePoint Graph tests.

---

# CI/CD

Workflow: `.github/workflows/Deploy.yml`. Build artifact → zip package → Run From Package. Non-secret app settings come from workflow `vars.*`; secrets (`HELPDESK_PAT`, `GRAPH_SUBSCRIPTION_CLIENT_STATE`) are uploaded to Key Vault and referenced. Graph auth is the managed identity (no Graph client secret deployed). Ingress: Azure API Management.

> The pipeline does not yet run `npm test` as a gate.

---

# Observability

Application Insights is enabled. Primary runtime troubleshooting: Azure Portal → Function App → Log Stream.

Required roles: Contributor on subscription; PIM activation for Tenant Root Reader.
