// src/functions/process-mail.ts
// Storage-queue worker: the inbound orchestrator. A `notify` HTTP call enqueues
// { mailbox, messageId }; this worker fetches the message + attachments from Graph,
// finds-or-creates the Helpdesk ticket, uploads attachments to SharePoint, sends a reply-received
// ack via Graph (a NEW ticket is opened silently — no "ticket created" notice), then moves the
// message to a processed folder so duplicate notifications are no-ops.
//
// API/identity/routing/logging concerns live in their own modules (helpdesk-client,
// routing, logging); this file is the workflow + the attachment policy.
import { app, InvocationContext } from "@azure/functions";
import { AxiosError, AxiosInstance } from "axios";

import { createGraphClientFromEnv, graphConfigFromEnv } from "./graph-client";
import { acquireDrainLock } from "./drain-lock";
import { envInstantMs, envPositiveNumber, noticesEnabled, ticketingEnabled } from "./env";
import { MAIL_QUEUE_NAME, mailQueueOutput, type MailQueueItem } from "./mail-queue";
import {
  getMessage,
  listInboxMessageIds,
  listFolderMessageIds,
  listMessageAttachments,
  fetchAttachmentBytes,
  parseGraphMessage,
  resolveMailboxAddress,
  sendMailViaGraph,
  sendDebugEmail,
  ensureMailFolder,
  moveMessageToFolder,
  type InboundMessage,
  type AttachmentInfo,
  type AttachmentMeta,
} from "./graph-mail";
import {
  uploadAttachmentsToSharePoint,
  type UploadedAttachmentLink,
  type SharePointConfig,
  type SharePointUploadItem,
} from "./sharepoint";
import {
  existingTicketAutoReply,
  appendFolderAndFilenamesToBody,
  buildOversizeCommentText,
  neutralizeForgedMarker,
  relayedFromMarker,
} from "./templates";
import {
  createHelpdeskClient,
  getTicketShortId,
  listAgents,
  listTicketsByRequester,
  updateTicketMessage,
  createTicket,
  findExistingTicket,
  findTicketByShortId,
  type TicketSummary,
} from "./helpdesk-client";
import { extractTicketRef, normalizeRef } from "./subject";
import { normalizeInbox, normalizeMailboxKey, routeTeam, shouldIgnoreSender, shouldSuppressRecipient } from "./routing";
import {
  createBufferedLogger,
  createStepLogger,
  safeJson,
  type StepFn,
  type StepErrorFn,
} from "./logging";

// #region Configuration & Constants

const DEBUG_EMAIL_TO =
  process.env.DEBUG_EMAIL_TO ?? "clayton.smith@corespecialty.com";

// Folder inbound mail is moved to once handled (idempotency marker).
const PROCESSED_FOLDER = process.env.MAIL_PROCESSED_FOLDER ?? "HelpdeskProcessed";

// Folder an admin can drop mail into to have it REPLAYED through the inbound pipeline as if it just
// arrived. Scanned on every drain (alongside the inbox) so the existing sweep/notification triggers
// pick it up — no extra subscription. A reprocessed message bypasses the ignore-before cutoff and
// sends NO customer auto-reply (ticket-only), then moves to PROCESSED_FOLDER like inbox mail so it
// isn't replayed again. Created on demand (ensureMailFolder) so the drop target always exists. Read
// once at load.
const REPROCESS_FOLDER = process.env.MAIL_REPROCESS_FOLDER ?? "Reprocess";

// Attachment policy: PER-FILE raw-size limit for the SharePoint copy. Native mailboxes accept
// large mail bounded by Exchange's message-size limit (~150 MB). Files at/under this upload
// (chunked); files over it are skipped with a System note, while in-limit files in the same
// message still upload. Read once at load.
const DEFAULT_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;

const ATTACHMENT_MAX_BYTES = envPositiveNumber(
  process.env.ATTACHMENT_MAX_BYTES,
  DEFAULT_ATTACHMENT_MAX_BYTES
);

// Continuation output: when the inbox holds more than one drain batch, the worker re-enqueues a
// drain item for the same mailbox onto its own queue (mirrors notify.ts's enqueue) so a large
// backlog is fully drained across several short invocations instead of one long one.
const drainQueueOutput = mailQueueOutput();

// Max inbox messages drained per invocation. Must finish within host.json's functionTimeout
// (10 min); host.json's visibilityTimeout is set higher (15 min) so a slow run can't have its
// queue message re-picked by a second worker mid-drain and double-process. Kept conservative
// because a single message can carry up to ATTACHMENT_MAX_BYTES (100 MiB) of attachments — the
// continuation re-enqueue drains any overflow across subsequent invocations. Read once at load.
const DEFAULT_DRAIN_BATCH_SIZE = 10;

const DRAIN_BATCH_SIZE = envPositiveNumber(
  process.env.MAIL_DRAIN_BATCH_SIZE,
  DEFAULT_DRAIN_BATCH_SIZE,
  { integer: true }
);

// Drain cutoff: mail received BEFORE this instant is ignored — never ticketed/auto-replied and
// left untouched in the inbox. This exists because the inbox holds a pre-go-live backlog and the
// drain lists oldest-first, so without a cutoff it would process that backlog first. Default is the
// go-live boundary: 2026-06-19 6:00 PM US Eastern. June is EDT (UTC-4), so 18:00 ET == 22:00 UTC.
// Override per environment with MAIL_IGNORE_BEFORE (any Date-parseable value; ISO-8601 with a Z or
// offset is safest). Enforced two ways from this single source: (1) a server-side $filter on the
// inbox listing so old mail is never even fetched, and (2) a per-message guard below covering the
// always-included triggering id. Read once at load.
const DEFAULT_IGNORE_BEFORE_ISO = "2026-06-19T22:00:00Z";

const IGNORE_BEFORE_MS = envInstantMs(
  process.env.MAIL_IGNORE_BEFORE,
  DEFAULT_IGNORE_BEFORE_ISO
);
// Canonical UTC form for the Graph $filter, normalized from whatever offset the override used.
const IGNORE_BEFORE_ISO = new Date(IGNORE_BEFORE_MS).toISOString();

/**
 * Whether a message's Graph `receivedDateTime` is strictly before the ignore cutoff. Fails OPEN: a
 * missing/unparseable timestamp returns false (process it) — the cutoff only suppresses mail we can
 * positively date as old, never silently drops a message we can't date.
 */
export function isBeforeIgnoreCutoff(receivedDateTime: string | null, cutoffMs: number): boolean {
  if (!receivedDateTime) return false;
  const t = Date.parse(receivedDateTime);
  return Number.isFinite(t) && t < cutoffMs;
}

// #endregion

// #region Queue trigger entry

/**
 * Queue-triggered worker. Each notification is treated as "there is mail to drain": the worker
 * lists the WHOLE inbox for the mailbox and runs the per-message pipeline over every id, not just
 * the notified one. This sweeps up any message whose notification was dropped (e.g. during an app
 * reboot) — it would otherwise sit in the inbox forever with no queue item to trigger it.
 *
 * Throws if any message failed so the Functions runtime retries the drain (then poison-queues);
 * idempotency is provided by the move-to-processed step + the getMessage 404 short-circuit, so a
 * retry re-lists and reprocesses only the still-in-inbox failures.
 */
export async function processMail(
  queueItem: unknown,
  context: InvocationContext
): Promise<void> {
  const { logBuffer, attachBufferedLogger } = createBufferedLogger(context);
  attachBufferedLogger();
  const { step, stepError } = createStepLogger(context);

  const item = normalizeQueueItem(queueItem);
  if (!item) {
    context.log("process-mail: unparseable queue item; dropping", { queueItem });
    return;
  }
  const { mailbox, messageId } = item;
  step("Start: drain inbox", { mailbox, messageId: messageId ?? null });

  // Master mail-flow switch (TICKETING_TOGGLE). When OFF (the default), do NOT touch the mailbox:
  // no lock, no listing, no ticket create/update, no ack — and crucially no move to the processed
  // folder. Mail is left in the inbox so flipping the toggle back ON catches up the whole backlog on
  // the next drain (sweep-inbox and live notifications keep enqueuing drains while off). We return
  // WITHOUT throwing so this queue item is acked cleanly (no poison-queue churn).
  if (!ticketingEnabled()) {
    step("Ticketing disabled (TICKETING_TOGGLE off) — leaving mailbox untouched; no ticket/email this drain");
    return;
  }

  // Per-mailbox mutual exclusion across instances. On a multi-instance plan two notifications for
  // two emails that arrive close together produce two queue items that two instances drain at once;
  // both re-list the same inbox and both clear the non-atomic find-or-create for a not-yet-moved
  // message -> duplicate ticket + duplicate ack (CLAUDE.md invariant #4). The lock is keyed by
  // mailbox so different mailboxes still drain in parallel (scale-out preserved); only colliding
  // work on the SAME mailbox is serialized. See drain-lock.ts for the lease mechanics and the
  // fail-safe semantics (a storage error throws rather than draining unlocked).
  const graph = await createGraphClientFromEnv();

  // Canonicalize the mailbox into a single lock key. notify enqueues the mailbox GUID (Graph puts
  // the object id in the change notification) while sweep-inbox enqueues the configured email
  // address — and that address may be an alias domain (e.g. ...@corespecialtyins.com). Collapsing
  // both to the UPN form ("<local>@corespecialty.com") makes a notify-triggered drain and a
  // sweep-triggered drain of one mailbox contend on the SAME lease — without this they'd take
  // different locks and could still double-process. An EMAIL is normalized deterministically (no
  // Graph call: aliases aren't resolvable via /users/{upn}, and a per-mailbox bounce there would
  // strand all of that mailbox's mail — the original bug). A GUID/object id is resolved to its UPN
  // via Graph, then normalized through the same key so the paths collide. We do NOT fall back to the
  // raw id on failure: a notify-drain on the GUID while a sweep-drain resolved to the email would
  // take divergent locks and reopen the duplicate bug. Instead we abort (queue retries).
  let lockKey: string;
  try {
    let canonical: string | null;
    if (mailbox.includes("@")) {
      canonical = normalizeMailboxKey(mailbox);
    } else {
      const resolved = await resolveMailboxAddress(graph, mailbox);
      canonical = resolved ? normalizeMailboxKey(resolved) : null;
    }
    if (!canonical) throw new Error(`could not resolve a canonical address for mailbox ${mailbox}`);
    lockKey = canonical;
  } catch (e) {
    stepError("DrainLock: mailbox canonicalization failed; aborting drain so the queue retries", e, { mailbox });
    throw e;
  }

  const lock = await acquireDrainLock(lockKey, { log: (...a: any[]) => step("DrainLock", a) });
  if (!lock) {
    // Another instance is already draining this mailbox. Defer instead of draining concurrently:
    // re-enqueue a fresh drain item. The holder drains the WHOLE inbox so it almost certainly
    // already covers this item; the re-enqueue catches anything that arrived after the holder's
    // listing snapshot, and sweep-inbox is the ultimate backstop. We return WITHOUT throwing so the
    // dequeue count isn't burned toward the poison queue, and the bounded wait inside
    // acquireDrainLock paces this so the re-enqueue isn't a busy loop.
    context.extraOutputs.set(drainQueueOutput, [JSON.stringify({ mailbox, messageId })]);
    step("DrainLock: mailbox busy; deferred drain (re-enqueued)", { mailbox, lockKey });
    return;
  }

  try {
    // Best-effort inbox listing: on failure, fall back to draining just the notified id (which is
    // exactly the pre-drain behavior), so a transient list failure can't regress single-message
    // delivery. A sweep item has no notified id, so a failed listing simply drains nothing this
    // round and the next sweep retries.
    let inboxIds: string[] = [];
    try {
      inboxIds = await listInboxMessageIds(graph, mailbox, DRAIN_BATCH_SIZE, IGNORE_BEFORE_ISO);
      step("Graph: listInboxMessageIds complete", { count: inboxIds.length, ignoreBefore: IGNORE_BEFORE_ISO });
    } catch (e) {
      stepError("listInboxMessageIds failed; draining notified message only", e, { mailbox });
    }

    // Reprocess folder: an admin drops mail here to replay it as if newly arrived. Listed on every
    // drain so the same triggers (live notification + the sweep) cover it without a dedicated
    // subscription. Best-effort and isolated from the inbox listing — a failure here (e.g. folder
    // create/list) must not regress the inbox drain. No date filter: reprocess bypasses the
    // ignore-before cutoff by design.
    let reprocessIds: string[] = [];
    try {
      const reprocessFolderId = await ensureMailFolder(graph, mailbox, REPROCESS_FOLDER);
      reprocessIds = await listFolderMessageIds(graph, mailbox, reprocessFolderId, DRAIN_BATCH_SIZE);
      if (reprocessIds.length > 0) {
        step("Graph: reprocess folder has mail to replay", { folder: REPROCESS_FOLDER, count: reprocessIds.length });
      }
    } catch (e) {
      stepError("Reprocess folder listing failed; skipping reprocess this round", e, { mailbox, folder: REPROCESS_FOLDER });
    }

    // Always include the triggering id when present (covers eventual-consistency where it isn't
    // listed yet), deduped and capped to the batch size. A sweep item carries no messageId. Inbox
    // ids run as normal inbound; reprocess ids run with `reprocess` set (cutoff bypass + ack
    // suppression). Folder-scoped ids never collide, so no cross-folder dedup is needed. Each folder
    // keeps its OWN batch cap (rather than sharing one) so a full inbox can't starve reprocess; the
    // trade-off is a single drain can process up to 2×DRAIN_BATCH_SIZE messages. That's fine for this
    // low-volume relay — reprocess is a rare manual action — and the continuation drain clears any
    // overflow in either folder across subsequent invocations.
    const inboxWorkIds = [...new Set([...inboxIds, ...(messageId ? [messageId] : [])])].slice(0, DRAIN_BATCH_SIZE);
    const work: { id: string; reprocess: boolean }[] = [
      ...inboxWorkIds.map((id) => ({ id, reprocess: false })),
      ...reprocessIds.slice(0, DRAIN_BATCH_SIZE).map((id) => ({ id, reprocess: true })),
    ];

    let failures = 0;
    for (const { id, reprocess } of work) {
      // Abort if the lease was lost mid-drain (a renewal failed, so another instance may now hold
      // the mailbox). Throwing here lets the queue retry the whole drain under a fresh lease;
      // already-handled messages 404-skip, so the only re-work is the still-in-inbox remainder.
      if (lock.lost) {
        throw new Error("process-mail: drain lock lost mid-drain; aborting so the queue retries under a fresh lease");
      }
      try {
        await processSingleMessage(graph, mailbox, id, step, stepError, reprocess);
      } catch (e) {
        failures++;
        const err = e as AxiosError;
        const body =
          (err?.response?.data as any) ?? (err?.message as any) ?? String(e ?? "Unknown error");
        stepError("Unhandled: error processing message", e, { messageId: id, body: safeJson(body) });

        // Best-effort, error-only debug email (gated by SEND_DEBUG_EMAIL). One per failed message.
        try {
          await sendDebugEmail({
            graph,
            fromMailbox: mailbox,
            to: DEBUG_EMAIL_TO,
            originalSubject: "error",
            debugDump: `Unhandled error (message ${id}):\n${safeJson(body)}`,
            logBuffer: logBuffer.value,
          });
        } catch (sendErr) {
          stepError("Debug email failed", sendErr, { messageId: id });
        }
      }
    }

    // If either listing hit the batch cap, the mailbox may hold more mail (inbox or reprocess) than
    // this run drained: re-enqueue a continuation drain so the backlog clears across several short
    // invocations instead of one long one that could overrun the visibility timeout. It
    // self-terminates — each run moves <= batch messages out of each folder, shrinking it until it
    // fits in a single run. extraOutputs only commit on a successful return, so this is skipped when
    // we throw below; a backlog left behind by a throw is re-derived on the next notification's drain.
    if ((inboxIds.length >= DRAIN_BATCH_SIZE || reprocessIds.length >= DRAIN_BATCH_SIZE) && failures === 0) {
      context.extraOutputs.set(drainQueueOutput, [JSON.stringify({ mailbox, messageId })]);
      step("Enqueued continuation drain", { mailbox });
    }

    step("Drain complete", { processed: work.length, failures });

    // Rethrow so the queue retries the drain (then poison-queues). Successful messages were moved
    // out of the inbox, so a retry re-lists and reprocesses ONLY the failures.
    if (failures > 0) {
      throw new Error(`process-mail: ${failures} message(s) failed during inbox drain`);
    }
  } finally {
    // Release the lease (best-effort) and stop renewing, on both the success and throw paths, so a
    // retried/duplicate drain isn't blocked behind a lease we no longer need.
    await lock.release();
  }
}

/**
 * Process one inbound message end-to-end: fetch it (404 short-circuits as an idempotent skip),
 * find-or-create the Helpdesk ticket, upload attachments, send the ack, then move it to the
 * processed folder. Throws on a genuine error so the drain loop can record the failure (send the
 * debug email, retry the drain) without one bad message stranding its siblings.
 */
async function processSingleMessage(
  graph: AxiosInstance,
  mailbox: string,
  messageId: string,
  step: StepFn,
  stepError: StepErrorFn,
  reprocess = false
): Promise<void> {
  // Idempotency: a duplicate/overlapping drain for an already-moved message 404s here.
  let msg;
  try {
    if (reprocess) step("Reprocess: replaying message as new inbound", { messageId });
    step("Graph: getMessage begin", { messageId });
    msg = await getMessage(graph, mailbox, messageId);
    step("Graph: getMessage complete", { messageId });
  } catch (e) {
    if ((e as AxiosError)?.response?.status === 404) {
      step("Message not found (already processed?); skipping", { messageId });
      return;
    }
    throw e;
  }

  const parsed = parseGraphMessage(msg);
  step("Parse: message", {
    fromAddress: parsed.fromAddress,
    toAddress: parsed.toAddress,
    subject: parsed.subject,
    replyTo: parsed.replyTo,
    receivedDateTime: parsed.receivedDateTime,
  });

  // Ignore-before-cutoff: mail received before the go-live boundary is left untouched in the inbox
  // (no ticket, no auto-reply, NOT moved to processed — matching the listing $filter that normally
  // keeps old mail from ever being listed). This guard catches the triggering id, which is always
  // included in the drain regardless of the listing filter. Reprocess is exempt by design: dropping
  // an old email into the Reprocess folder is an explicit request to replay it past the cutoff.
  if (!reprocess && isBeforeIgnoreCutoff(parsed.receivedDateTime, IGNORE_BEFORE_MS)) {
    step("Filter: received before ignore cutoff; leaving in inbox", {
      receivedDateTime: parsed.receivedDateTime,
      ignoreBefore: IGNORE_BEFORE_ISO,
    });
    return;
  }

  // Only the sender is truly required: without it there is no requester and nobody to
  // reply to. A blank subject or empty body is recoverable — substitute a placeholder so an
  // attachment-only or subject-less email still creates a ticket and gets an ack, instead of
  // being silently filed away unanswered (quiet data loss).
  if (!parsed.fromAddress) {
    step("Validate: missing sender address; moving to processed");
    await safeMoveToProcessed(graph, mailbox, messageId, step, stepError);
    return;
  }
  if (!parsed.subject) parsed.subject = "(no subject)";
  if (!parsed.text) parsed.text = "(no message body)";

  if (shouldIgnoreSender(parsed.fromAddress)) {
    step("Filter: ignored sender; moving to processed", { from: parsed.fromAddress });
    await safeMoveToProcessed(graph, mailbox, messageId, step, stepError);
    return;
  }

  const helpdesk = createHelpdeskClient();

  step("Graph: listMessageAttachments begin");
  const attachmentInfos = await listMessageAttachments(
    graph,
    mailbox,
    messageId,
    (...a: any[]) => step("Attachment: detail", a)
  );
  const plan = planAttachments(attachmentInfos, ATTACHMENT_MAX_BYTES);
  // Bytes are fetched lazily, one file at a time, only for files that will actually upload.
  const uploadItems: SharePointUploadItem[] = plan.uploadable.map((a) => ({
    name: a.name,
    getBytes: () => fetchAttachmentBytes(graph, mailbox, messageId, a.id),
  }));
  step("Attachment: policy", {
    count: attachmentInfos.length,
    uploadable: plan.uploadable.length,
    blocked: plan.blocked.length,
  });

  step("Helpdesk: listTicketsByRequester begin");
  const tickets = await listTicketsByRequester(helpdesk, parsed.fromAddress);
  let existingTicket: TicketSummary | null = findExistingTicket(parsed.subject, tickets);
  step("Helpdesk: ticket lookup", {
    requester: parsed.fromAddress,
    count: tickets.length,
    found: !!existingTicket,
    ticketId: existingTicket?.ID ?? null,
  });

  // Non-requester reply threading (NOTICES_TOGGLE): a follower / person-in-the-loop replying to a
  // notice carries the [#shortID] tag, but the sender-scoped lookup above can't see the ticket
  // (they aren't its requester) — without this, their reply opens a duplicate ticket. The tag is
  // AUTHORITATIVE: it also outranks findExistingTicket's subject-substring fallback picking one of
  // the sender's OWN tickets (a coincidence like "Printer down" ⊂ "Re: Printer down [#other]"
  // would otherwise silently misfile the reply). But a tag alone never grants access — it appears
  // in every outbound subject, so anyone forwarded a relay email has seen one — the SENDER must be
  // part of the ticket's audience (requester, person-in-the-loop, or follower agent) or the reply
  // falls through to today's behavior. All lookups run BEFORE any side effect: a transient failure
  // (5xx/429/listAgents) rethrows -> queue retry, never a mis-filed reply.
  let relayedFrom: string | undefined;
  if (noticesEnabled()) {
    const ref = extractTicketRef(parsed.subject);
    const refMatchedSenderTicket =
      !!ref && !!existingTicket && normalizeRef(existingTicket.shortID) === normalizeRef(ref);
    if (ref && !refMatchedSenderTicket) {
      const byRef = await findTicketByShortId(helpdesk, ref);
      step("Helpdesk: ticket lookup by subject ref", {
        ref,
        found: !!byRef,
        ticketId: byRef?.ID ?? null,
      });
      if (byRef) {
        const sender = (parsed.fromAddress ?? "").trim().toLowerCase();
        const requester = (byRef.requesterEmail ?? "").trim().toLowerCase();
        if (sender && sender === requester) {
          // The requester's own reply that the sender-scoped list missed (e.g. a paging gap).
          existingTicket = byRef;
        } else if (sender) {
          const inAudience =
            byRef.ccEmails.includes(sender) ||
            (byRef.followerIds.length > 0 &&
              (await listAgents(helpdesk)).some(
                (a) =>
                  byRef.followerIds.includes(a.ID) &&
                  (a.email ?? "").trim().toLowerCase() === sender
              ));
          if (inAudience) {
            existingTicket = byRef;
            relayedFrom = parsed.fromAddress;
          } else {
            step("Helpdesk: subject ref ignored — sender not in the ticket's audience", {
              ref,
              sender: parsed.fromAddress,
            });
          }
        }
      }
    }
  }

  const mailboxAddress = await resolveMailboxAddress(graph, mailbox);
  const normalizedInbox = normalizeInbox(mailboxAddress ?? parsed.toAddress);
  const teamId = routeTeam(normalizedInbox);
  step("Route: inbox + team", { normalizedInbox, teamId });

  if (existingTicket) {
    await handleExistingTicket({
      graph, helpdesk, mailbox, parsed, existingTicket, uploadItems,
      // No ack for a RELAYED (non-requester) thread: acking would mail the follower/loop sender a
      // tagged message, and an auto-responder on their side would reply, re-thread, and re-ack
      // forever — the ack is the fuel of that loop. Their reply still lands in the ticket.
      blocked: plan.blocked, suppressAck: reprocess || relayedFrom !== undefined, relayedFrom, step, stepError,
    });
  } else {
    await handleNewTicket({
      helpdesk, parsed, teamId, normalizedInbox,
      uploadItems, blocked: plan.blocked, step, stepError,
    });
  }

  await safeMoveToProcessed(graph, mailbox, messageId, step, stepError);
  step("Done", { messageId });
}

app.storageQueue("process-mail", {
  queueName: MAIL_QUEUE_NAME,
  connection: "AzureWebJobsStorage",
  extraOutputs: [drainQueueOutput],
  handler: processMail,
});

// #endregion

// #region Ticket branches

/**
 * Build the ticket message body for an inbound email: the FULL email body (entire quoted thread
 * included — the business wants the whole chain on every ticket, so no quote/signature stripping)
 * plus the SharePoint folder link and uploaded filenames (when any). Shared by the new- and
 * existing-ticket branches.
 */
function buildTicketMessageText(
  rawText: string,
  uploadedLinks: UploadedAttachmentLink[],
  folderWebUrl?: string
): string {
  return appendFolderAndFilenamesToBody(
    rawText,
    uploadedLinks.map((u) => u.filename),
    folderWebUrl
  );
}

async function handleExistingTicket(opts: {
  graph: AxiosInstance;
  helpdesk: AxiosInstance;
  mailbox: string;
  parsed: InboundMessage;
  existingTicket: TicketSummary;
  uploadItems: SharePointUploadItem[];
  blocked: AttachmentMeta[];
  suppressAck: boolean;
  /** Set when a NON-requester's tagged reply was threaded in — prefixes the relayed-from marker. */
  relayedFrom?: string;
  step: StepFn;
  stepError: StepErrorFn;
}): Promise<void> {
  const { graph, mailbox, helpdesk, parsed, existingTicket, uploadItems, blocked, suppressAck, relayedFrom, step, stepError } = opts;

  const { folderWebUrl, uploadedLinks } = await uploadToTicket({
    helpdesk, ticketId: existingTicket.ID, fromAddress: parsed.fromAddress, uploadItems, step, stepError,
  });

  // The marker line attributes a threaded non-requester reply in the Helpdesk UI (the API author
  // is a generic "client") AND lets the webhook's notice pass exclude the sender from the notice
  // about their own message (templates.ts's marker pair). A NON-relayed body is neutralized so a
  // hand-typed first-line marker can't spoof that attribution.
  const baseText = relayedFrom
    ? `${relayedFromMarker(relayedFrom)}\n\n${parsed.text}`
    : neutralizeForgedMarker(parsed.text);
  const messageText = buildTicketMessageText(baseText, uploadedLinks, folderWebUrl);
  await updateTicketMessage({ helpdesk, ticketId: existingTicket.ID, text: messageText, authorType: "client" });

  // Suppressed for a reprocess replay (the original ack already went out) and for a relayed
  // non-requester thread (acking a tagged mail back at the sender fuels an auto-responder loop).
  if (suppressAck) {
    step("Ack suppressed (reprocess replay or relayed non-requester reply)", { ticketId: existingTicket.ID });
  } else {
    const ack = existingTicketAutoReply({
      inboundSubject: parsed.subject,
      shortId: existingTicket.shortID,
      ticketId: existingTicket.ID,
    });
    await sendAckEmail({
      graph, mailbox,
      to: parsed.replyTo ?? parsed.fromAddress,
      subject: ack.subject,
      body: ack.body,
      step, stepError,
    });
  }

  if (blocked.length > 0) {
    await addOversizeNote(helpdesk, existingTicket.ID, blocked, step, stepError);
  }
}

async function handleNewTicket(opts: {
  helpdesk: AxiosInstance;
  parsed: InboundMessage;
  teamId: string;
  normalizedInbox: string;
  uploadItems: SharePointUploadItem[];
  blocked: AttachmentMeta[];
  step: StepFn;
  stepError: StepErrorFn;
}): Promise<void> {
  const {
    helpdesk, parsed, teamId, normalizedInbox,
    uploadItems, blocked, step, stepError,
  } = opts;

  const createdTicketId = await createTicket({
    helpdesk,
    subject: parsed.subject,
    requesterEmail: parsed.fromAddress,
    requesterName: parsed.fromName ?? parsed.fromAddress,
    teamId,
    // Full email body, entire thread included (no quote/signature stripping); a forged first-line
    // relayed-from marker is neutralized (the notice pass reads markers as attribution).
    messageText: neutralizeForgedMarker(parsed.text),
    customFields: { email: parsed.fromAddress, inbox: normalizedInbox },
  });
  step("Helpdesk: createTicket complete", { createdTicketId });

  // No "ticket has been created" notice is sent to the requester — neither from the relay nor from
  // Helpdesk (Helpdesk's own requester notifications are disabled in its admin settings — see
  // CLAUDE.md invariant #2). A new ticket is opened silently. Replies to an EXISTING ticket are
  // still acked (handleExistingTicket), and agent replies still go out via the helpdesk webhook.

  const { folderWebUrl, uploadedLinks } = await uploadToTicket({
    helpdesk, ticketId: createdTicketId, fromAddress: parsed.fromAddress, uploadItems, step, stepError,
  });

  // Only patch a follow-up message if attachments produced something to link. This runs after the
  // ticket is created, so it must be best-effort: a throw here would rethrow → the queue retries →
  // the (now-existing) ticket is re-handled, creating a duplicate. Logging-and-continuing lets the
  // message reach the processed-folder move so it is not reprocessed.
  if (folderWebUrl || uploadedLinks.length > 0) {
    try {
      const messageText = buildTicketMessageText(
        neutralizeForgedMarker(parsed.text),
        uploadedLinks,
        folderWebUrl
      );
      await updateTicketMessage({ helpdesk, ticketId: createdTicketId, text: messageText, authorType: "client" });
    } catch (e) {
      stepError("Append attachment links failed (ticket created; not retried)", e, { createdTicketId });
    }
  }

  if (blocked.length > 0) {
    await addOversizeNote(helpdesk, createdTicketId, blocked, step, stepError);
  }
}

/**
 * Upload the in-limit attachments (if any) into the ticket's SharePoint folder. Never throws —
 * an upload failure is logged and the ticket flow continues without the folder/links.
 */
async function uploadToTicket(opts: {
  helpdesk: AxiosInstance;
  ticketId: string;
  fromAddress: string;
  uploadItems: SharePointUploadItem[];
  step: StepFn;
  stepError: StepErrorFn;
}): Promise<{ folderWebUrl?: string; uploadedLinks: UploadedAttachmentLink[] }> {
  const { helpdesk, ticketId, fromAddress, uploadItems, step, stepError } = opts;
  if (uploadItems.length === 0) return { uploadedLinks: [] };

  try {
    const shortId = await getTicketShortId(helpdesk, ticketId);
    const sp = await uploadAttachmentsToSharePoint({
      config: sharePointConfig(),
      attachments: uploadItems,
      folderName: `${shortId} - ${fromAddress}`,
      log: (...a: any[]) => step("SPO: detail", a),
    });
    if (sp) return { folderWebUrl: sp.folderWebUrl, uploadedLinks: sp.uploaded };
  } catch (e) {
    stepError("SPO upload failed (ticket still updated)", e, { ticketId });
  }
  return { uploadedLinks: [] };
}

async function addOversizeNote(
  helpdesk: AxiosInstance,
  ticketId: string,
  blocked: AttachmentMeta[],
  step: StepFn,
  stepError: StepErrorFn
): Promise<void> {
  try {
    const text = buildOversizeCommentText({ blocked, maxBytesPerFile: ATTACHMENT_MAX_BYTES });
    await updateTicketMessage({ helpdesk, ticketId, text, authorType: "agent" });
    step("Helpdesk: oversize note added", { ticketId });
  } catch (err) {
    stepError("Helpdesk: oversize note failed", err, { ticketId });
  }
}

// #endregion

// #region Outbound mail (ack) + idempotency move

/**
 * Send a best-effort acknowledgement from the receiving shared mailbox. Validates the to
 * address and never throws — failures are logged via the step loggers.
 */
async function sendAckEmail(opts: {
  graph: AxiosInstance;
  mailbox: string;
  to: string | null | undefined;
  subject: string; // already threaded (built in templates.ts)
  body: string;
  step: StepFn;
  stepError: StepErrorFn;
}): Promise<void> {
  const { graph, mailbox, to, subject, body, step, stepError } = opts;
  const ackTo = (to ?? "").trim();
  const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  if (!emailOk(ackTo)) {
    step("Ack skipped (invalid to)", { ackTo });
    return;
  }
  // Loop guard: never ack one of our own drain mailboxes (a MAILBOX_ADDRESSES entry, or the same
  // mailbox under an alias company domain) — the ack would re-ingest as a new inbound, opening a
  // fresh ticket that acks back, ad infinitum. Ordinary internal senders still get acked. (Outbound
  // counterpart to shouldIgnoreSender.)
  if (shouldSuppressRecipient(ackTo)) {
    stepError("Ack skipped: recipient is an in-scope/monitored address (loop guard)", undefined, { ackTo });
    return;
  }
  try {
    await sendMailViaGraph({ graph, mailbox, to: ackTo, subject, body });
    step("Ack sent", { to: ackTo });
  } catch (e) {
    stepError("Ack failed (ignored)", e, { to: ackTo, subject });
  }
}

/**
 * Move the source message to the processed folder; never throws (the ticket is already
 * created/updated by this point).
 *
 * The move is the idempotency linchpin, so its failure modes matter:
 *  - A 404 means the message is already gone (a concurrent/duplicate drain moved it). That IS the
 *    idempotent outcome we want — log it at info, not as a failure.
 *  - Any OTHER failure leaves the message in the inbox, where the next drain re-lists it,
 *    re-matches the ticket we just created, and RE-ACKS the customer. The Graph client has
 *    already retried transient 429/503s, so reaching here means it is persistent — surface it at
 *    error severity (alertable) rather than letting it silently loop. We deliberately do NOT
 *    rethrow: a throw would trigger the queue retry and re-ack immediately instead of eventually.
 */
async function safeMoveToProcessed(
  graph: AxiosInstance,
  mailbox: string,
  messageId: string,
  step: StepFn,
  stepError: StepErrorFn
): Promise<void> {
  try {
    const folderId = await ensureMailFolder(graph, mailbox, PROCESSED_FOLDER);
    await moveMessageToFolder(graph, mailbox, messageId, folderId);
    step("Moved message to processed folder", { folder: PROCESSED_FOLDER });
  } catch (e) {
    if ((e as AxiosError)?.response?.status === 404) {
      step("Move skipped: message already moved (404)", { messageId });
      return;
    }
    stepError(
      "Move to processed FAILED — message stays in inbox and WILL be reprocessed/re-acked until this succeeds",
      e,
      { messageId, folder: PROCESSED_FOLDER }
    );
  }
}

function sharePointConfig(): SharePointConfig {
  return {
    ...graphConfigFromEnv(),
    siteUrl: process.env.SPO_SITE_URL as string,
    libraryName: process.env.SPO_LIBRARY_NAME as string,
  };
}

// #endregion

// #region Attachment policy

/**
 * Whether an attachment is ignored by the relay (not uploaded, not counted): inline images
 * (signatures/logos), tiny images (<20 KB), or images named "signature".
 */
function isIgnoredAttachment(a: AttachmentInfo): boolean {
  if (a.isInline) return true;
  const isImage =
    a.contentType.startsWith("image/") ||
    /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(a.name);
  if (!isImage) return false;
  if (a.size < 20 * 1024) return true;
  if (a.name.toLowerCase().includes("signature")) return true;
  return false;
}

/**
 * Split attachments by the PER-FILE size limit: each non-ignored file at/under maxBytesPerFile
 * is uploadable; files over it are blocked (skipped + noted) while in-limit siblings still
 * upload. Operates on metadata only — no bytes are fetched here.
 */
export function planAttachments(
  infos: AttachmentInfo[],
  maxBytesPerFile: number
): { uploadable: AttachmentInfo[]; blocked: AttachmentMeta[] } {
  const uploadable: AttachmentInfo[] = [];
  const blocked: AttachmentMeta[] = [];
  for (const a of infos) {
    if (isIgnoredAttachment(a)) continue;
    if (a.size > maxBytesPerFile) {
      blocked.push({ filename: a.name, size: a.size });
      continue;
    }
    uploadable.push(a);
  }
  return { uploadable, blocked };
}

// #endregion

// #region Queue helpers

/**
 * Parse the queue payload into { mailbox, messageId } (accepts an object or a JSON string).
 */
export function normalizeQueueItem(queueItem: unknown): MailQueueItem | null {
  let obj: any = queueItem;
  if (typeof queueItem === "string") {
    try {
      obj = JSON.parse(queueItem);
    } catch {
      return null;
    }
  }
  const mailbox = obj?.mailbox;
  const messageId = obj?.messageId;
  // mailbox is required. messageId is optional — a sweep item (from sweep-inbox) omits it and
  // means "drain this mailbox's whole inbox" — but if present it must be a non-empty string.
  if (typeof mailbox !== "string" || !mailbox) return null;
  if (messageId !== undefined && (typeof messageId !== "string" || !messageId)) return null;
  return messageId ? { mailbox, messageId } : { mailbox };
}

// #endregion
