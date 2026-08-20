// src/functions/helpdesk.ts
// Helpdesk webhook handler. On a UI-authored tickets.create it emails the requester (when enabled)
// only for agent replies; on tickets.update
// it emails the requester only when the webhook's own action carries an agent-authored, non-email,
// public, non-system-note message. Normally that message IS the last event; the one sanctioned
// exception is a reply whose action also appends trailing companion metadata (assignment/status,
// or an attachments event), which can land after the message (see
// selectEmailableAgentMessage). Standalone non-message events (status/assignment/audience changes)
// still send nothing, and a per-(ticket, event) claim makes each message event's requester email
// send-once across webhooks. Independently enabled notice audiences are handled before those
// requester-specific gates. Outbound mail goes through Graph sendMail from the shared mailbox owned
// by the team the ticket is ASSIGNED to (resolved once per delivery — see reply-mailbox.ts), so a
// reassigned ticket answers from the mailbox the responding team drains rather than the one the
// original email happened to land in.
// See README "Helpdesk Webhook Flow".
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { AxiosInstance } from "axios";
import { TicketUpdatedPayload } from "../types/TicketUpdatePayload";

import { createGraphClientFromEnv } from "./graph-client";
import { sendMailViaGraph } from "./graph-mail";
import { agentReplyEmail } from "./templates";
import { createHelpdeskClient } from "./helpdesk-client";
import { shouldSuppressRecipient } from "./routing";
import { createStepLogger, type StepErrorFn, type StepFn } from "./logging";
import {
  agentNoticesEnabled,
  followersNoticesEnabled,
  submitterRepliesEnabled,
} from "./env";
// isSystemNoteText and selectActionEvent/eventClaimId live in ticket-notices.ts so the requester
// gate and the notice classifier can't drift apart ("System note:" comments are never emailed to
// the requester, and both consumers agree on which event a webhook's action is about).
import {
  eventClaimId,
  isSystemNoteText,
  selectActionAttachmentFiles,
  selectActionEvent,
  sendTicketNotices,
} from "./ticket-notices";
import {
  prepareOutboundAttachments,
  stripHelpdeskAttachmentBlock,
} from "./helpdesk-attachments";
import {
  buildReplyClaimsClient,
  claimReply,
  isReplyClaimed,
  replyClaimBlobName,
} from "./reply-claims";
// Which shared mailbox this webhook's mail goes out AS: the ASSIGNED TEAM's mailbox, not the
// ticket's stamped-once customFields.inbox (which stops matching the responding team the moment the
// ticket is reassigned). Falls back to that inbox for a team that owns no mailbox.
import { resolveReplyMailbox } from "./reply-mailbox";
import { webhookGateMaxWaitMs } from "./helpdesk-gate";

type TicketPayload = TicketUpdatedPayload;
type TicketEvents = TicketUpdatedPayload["payload"]["events"];
type TicketEvent = TicketEvents[number];

/** The message the webhook's action carries, plus the event it came from (for source/claim keys). */
type EmailableSelection = { text: string; event: TicketEvent };

export async function helpdesk(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const { step, stepWarn, stepError } = createStepLogger(context);

  // The three webhook-driven audiences are independent. The webhook is dark only when all three
  // are off. Dev and Prod share one Helpdesk account, so each webhook toggle must be enabled in at
  // most one environment or recipients are duplicated.
  const submitterOn = submitterRepliesEnabled();
  const agentOn = agentNoticesEnabled();
  const followersOn = followersNoticesEnabled();
  if (!submitterOn && !agentOn && !followersOn) {
    step("Webhook audiences disabled — skipping webhook; no email/ticket update");
    // Explicit 200 (load-bearing): Helpdesk treats delivery as handled and does NOT retry the webhook.
    return { status: 200, body: "Webhook audiences disabled" };
  }

  const payload = (await request.json()) as unknown as TicketPayload;
  const events = payload.payload.events;
  step("Webhook received", {
    eventType: payload.eventType,
    lastSource: events?.at(-1)?.source?.type,
    ticketId: payload.payload.ID,
  });

  // One resolution per webhook, shared by every audience below (requester reply, follower/cc and
  // assigned-agent notices) so a single delivery can never send some of its mail as one mailbox and
  // the rest as another. Tied to the team assigned at the time of this event, so a reassigned ticket
  // answers from — and its replies come back to — the mailbox the responding team actually owns.
  const replyMailbox = resolveReplyMailbox(payload);
  step("Mailbox: resolved sender", {
    mailbox: replyMailbox.mailbox,
    source: replyMailbox.source,
    teamId: replyMailbox.teamId,
    inbox: payload.payload.customFields?.inbox ?? null,
    ...(replyMailbox.reason ? { reason: replyMailbox.reason } : {}),
  });

  const graph = await createGraphClientFromEnv();
  // Deliberately a SHORT gate budget, and no deferral. This handler has nowhere to put the work
  // back: a slow response makes Helpdesk redeliver the webhook, and the sends here are not
  // idempotent, so a redelivery duplicates customer and agent email. It therefore cooperates with a
  // brief cooldown and then dispatches anyway — worst case it collects one 429, which the retry
  // policy already absorbs. The webhook is 1-3 Helpdesk calls per event; the drain is the volume
  // the gate exists to hold back.
  const helpdeskClient = createHelpdeskClient(
    { step, stepWarn, stepError },
    { gateMaxWaitMs: webhookGateMaxWaitMs() }
  );

  /**
  * Assigned-agent and follower / people-in-the-loop notices. Deliberately BEFORE the requester-
  * specific gates below (email-sourced skip, non-agent skip, missing requester.email return) —
   * notice audiences hear about events the requester does not, so those gates must not starve this
   * pass. Best-effort like the rest of the handler: sendTicketNotices never throws (and is wrapped
   * anyway) because a 500 makes Helpdesk redeliver the webhook and every email would duplicate.
   */
  if (
    (agentOn || followersOn) &&
    (payload.eventType === "tickets.create" || payload.eventType === "tickets.update")
  ) {
    try {
      await sendTicketNotices({
        graph,
          helpdesk: helpdeskClient,
        payload,
        mailbox: replyMailbox.mailbox,
        step,
        stepError,
        followers: followersOn,
        agent: agentOn,
      });
    } catch (e) {
      stepError("Notices: pass FAILED (ignored)", e, { ticketId: payload.payload.ID });
    }
  }

  /**
   * tickets.create (from the Helpdesk UI): email the requester only when SUBMITTER_REPLIES is on
   * and the create's last event is an agent reply. Customer-emails-in are client-authored and
   * already handled by the inbound worker, so they are not echoed back. The address comes from the
   * ticket's Submitter (`payload.requester.email`) — the deprecated `customFields.email` mirror was
   * retired once the field was deleted in Helpdesk.
   */
  if (
    payload.eventType === "tickets.create" &&
    payload.payload.source.detailedSource === "helpdesk"
  ) {
    // Best-effort, like the update branch below: never let this throw. A throw here returns 500,
    // Helpdesk retries the webhook, and sendAgentReply runs again — a DUPLICATE email to the
    // requester (the send is not idempotent). Log and move on instead.
    try {
      const requesterEmail = (payload.payload.requester.email ?? "").trim();

      if (!submitterOn) {
        step("Create: submitter replies disabled; skipping requester email");
      } else {
        const selection = selectEmailableAgentMessage(events);
        if (selection) {
          if (!requesterEmail) {
            step("Create: requester email missing; skipping requester reply");
            return { body: "No requester email found, not sending email" };
          }
          await sendAgentReplyOnce(
            graph,
            helpdeskClient,
            payload,
            selection,
            requesterEmail,
            replyMailbox.mailbox,
            step,
            stepError
          );
        } else {
          step("Create: nothing emailable (client-authored / private / system note)");
        }
      }
    } catch (e) {
      stepError("Create: error handling tickets.create (ignored)", e, {
        ticketId: payload.payload.ID,
      });
    }
  }

  /**
   * tickets.update gates: selectEmailableAgentMessage admits only a message the webhook's own
  * action carries (the last event, or a message immediately behind same-action companion
  * metadata events) and requires it to be agent-authored and public — a standalone status change,
   * reassignment, or other non-message event sends nothing. The email-source skip is applied to
   * the SELECTED event: a customer email-in was already handled by the inbound worker.
   */
  if (payload.eventType !== "tickets.update") {
    return { body: "Not a ticket update event" };
  }
  if (!submitterOn) {
    step("Update: submitter replies disabled; skipping requester email");
    return { body: "Submitter replies disabled" };
  }
  const selection = selectEmailableAgentMessage(events);
  if (!selection) {
    step("Update: no emailable agent message on this event; skipping");
    return { body: "No emailable agent message on this event" };
  }
  if (selection.event.source?.type === "email") {
    step("Update: email-sourced event already handled inbound; skipping");
    return { body: "Received an email event - already handled by the inbound webhook" };
  }

  /**
   * tickets.update agent branch.
   */
  try {
    const requesterEmail = (payload.payload.requester?.email ?? "").trim();
    if (!requesterEmail) {
      step("Update: no requester email; skipping");
      return { body: "No requester email found, not sending email" };
    }

    await sendAgentReplyOnce(
      graph,
      helpdeskClient,
      payload,
      selection,
      requesterEmail,
      replyMailbox.mailbox,
      step,
      stepError
    );
  } catch (e) {
    stepError("Update: error sending agent reply (ignored)", e);
  }

  return { body: "Agent event processed" };
}

app.http("helpdesk", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: helpdesk,
});

/** The event's message text iff it is agent-authored, public, non-system-note, non-blank. */
function visibleAgentMessageText(event: TicketEvent | undefined): string | null {
  if (event?.author?.type !== "agent") return null;
  const text = event?.message?.text;
  if (!text || !text.trim()) return null; // not a message event, or nothing visible to send
  if (event?.message?.isPrivate) return null;
  if (isSystemNoteText(text)) return null;
  return text;
}

/**
 * The message to email the requester, or null if nothing may be emailed for this webhook.
 * Shared by the create and update branches, and anchored to the webhook's own ACTION via the
 * shared selectActionEvent (ticket-notices.ts): normally the LAST event; the one sanctioned
 * exception is an agent reply whose action also appends trailing companion metadata
 * (assignment/status/attachments), where the message sits behind that run and qualifies only
 * within the same-action time window — without that, a reply with uploaded files can be silently
 * dropped until a later resend. Whatever event is selected must itself be agent-authored AND
 * carry a public, non-system-note, non-blank message.
 *
 * There is deliberately still NO general fallback to an older visible message: the payload's
 * events array is the ticket's FULL history, so a fallback turns every agent-authored non-message
 * event (status change, reassignment, follower/cc edit, attachments-only reply) into an email of
 * the last visible message on the ticket — usually the customer's own words echoed back to them.
 * selectActionEvent's time window (and the per-event send-once claim in sendAgentReplyOnce) is
 * what keeps the companion exception from reopening that echo path.
 */
function selectEmailableAgentMessage(events: TicketEvents): EmailableSelection | null {
  const event = selectActionEvent(events);
  if (!event) return null;
  const text = visibleAgentMessageText(event);
  if (!text) return null;
  return { text, event };
}

/**
 * Send one requester email for one message event, at most once across webhooks.
 *
 * The same message event can reach this handler more than once — a webhook redelivery, or a
 * companion-selected reply that a later metadata webhook (whose history still ends near the same
 * message) would select again. A create-once claim keyed (ticketId, eventID) makes the send
 * idempotent. Deliberately AVAILABILITY-FIRST, the opposite of alerts.ts's fail-closed claim: a
 * storage failure on the check or the write is logged and the reply still goes out, because
 * silently dropping a customer-facing reply is worse than the rare duplicate the claim exists to
 * prevent. Events without an ID (not observed in live payloads) send unguarded, preserving the
 * pre-claim behavior.
 */
async function sendAgentReplyOnce(
  graph: AxiosInstance,
  helpdesk: AxiosInstance,
  payload: TicketPayload,
  selection: EmailableSelection,
  toEmail: string,
  mailbox: string,
  step: StepFn,
  stepError: StepErrorFn
): Promise<void> {
  const ticketId = payload.payload.ID;
  const eventId = eventClaimId(selection.event);
  const claimName = eventId ? replyClaimBlobName(ticketId, eventId) : null;

  let claimClient: AxiosInstance | null = null;
  if (claimName) {
    try {
      claimClient = await buildReplyClaimsClient();
      if (await isReplyClaimed(claimClient, claimName)) {
        step("Agent reply already sent for this message event (claimed); skipping", {
          ticketId,
          eventId,
        });
        return;
      }
    } catch (e) {
      stepError("Reply claim check failed; sending without the duplicate guard", e, {
        ticketId,
        eventId,
      });
      claimClient = null;
    }
  }

  const actionFiles = selectActionAttachmentFiles(payload.payload.events);
  let outboundAttachments: import("./graph-mail").OutboundMailAttachment[] = [];
  let bodyText = selection.text;
  if (actionFiles.length) {
    const prepared = await prepareOutboundAttachments({
      helpdesk,
      files: actionFiles,
      step,
      stepError,
      context: "submitter",
    });
    outboundAttachments = prepared.attachments;
    if (
      prepared.totalFiles > 0 &&
      prepared.attachedFiles === prepared.totalFiles &&
      prepared.skippedFiles === 0
    ) {
      bodyText = stripHelpdeskAttachmentBlock(bodyText);
    }
    step("Agent reply: attachment prep", {
      total: prepared.totalFiles,
      attached: prepared.attachedFiles,
      skipped: prepared.skippedFiles,
    });
  }

  const sent = await sendAgentReply(
    graph,
    payload,
    bodyText,
    toEmail,
    mailbox,
    step,
    outboundAttachments
  );
  if (sent) step("Agent reply emailed", { ticketId, eventId, mailbox });

  if (sent && claimName) {
    try {
      claimClient = claimClient ?? (await buildReplyClaimsClient());
      await claimReply(
        claimClient,
        claimName,
        JSON.stringify({ ticketId, eventId, to: toEmail, sentAt: new Date().toISOString() })
      );
    } catch (e) {
      stepError("Reply claim write failed; a later webhook may re-send this reply", e, {
        ticketId,
        eventId,
      });
    }
  }
}

/**
 * Email the requester an agent reply (text only) from the shared mailbox the caller resolved — the
 * ASSIGNED TEAM's mailbox (reply-mailbox.ts), so a reassigned ticket stops answering from the
 * mailbox the original email happened to land in and the requester's reply comes back to the team
 * that is working it.
 *
 * Loop guard: if the requester resolves to one of our own drain mailboxes (a MAILBOX_ADDRESSES
 * entry, or the same mailbox under an alias company domain), the reply is suppressed — sending it
 * would deposit mail into a drained inbox, opening a new ticket that acks back, looping. Ordinary
 * internal requesters still get replies. (Outbound counterpart to the inbound `shouldIgnoreSender`
 * guard.)
 */
async function sendAgentReply(
  graph: AxiosInstance,
  payload: TicketPayload,
  text: string,
  toEmail: string,
  mailbox: string,
  step: StepFn,
  attachments: import("./graph-mail").OutboundMailAttachment[] = []
): Promise<boolean> {
  if (shouldSuppressRecipient(toEmail)) {
    step("Agent reply skipped: recipient is an in-scope/monitored address (loop guard)", { toEmail });
    return false;
  }
  const { subject, body } = agentReplyEmail({
    inboundSubject: payload.payload.subject,
    shortId: payload.payload.shortID,
    body: text,
  });
  await sendMailViaGraph({
    graph,
    mailbox,
    to: toEmail,
    subject,
    body,
    attachments,
  });
  return true;
}
