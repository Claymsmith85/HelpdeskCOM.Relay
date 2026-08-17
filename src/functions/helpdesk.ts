// src/functions/helpdesk.ts
// Helpdesk webhook handler. On a UI-authored tickets.create it patches the requester email into
// customFields and (when enabled, only for agent replies) emails the requester; on tickets.update
// it emails the requester only when the webhook's own action carries an agent-authored, non-email,
// public, non-system-note message. Normally that message IS the last event; the one sanctioned
// exception is a reply whose action also auto-assigned the ticket or changed its status, which
// lands trailing assignment/status companion events after the message (see
// selectEmailableAgentMessage). Standalone non-message events (status/assignment/audience changes)
// still send nothing, and a per-(ticket, event) claim makes each message event's requester email
// send-once across webhooks. Independently enabled notice audiences are handled before those
// requester-specific gates. Outbound mail goes through Graph sendMail from the shared mailbox.
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
import { createHelpdeskClient, patchCustomFields } from "./helpdesk-client";
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
  selectActionEvent,
  sendTicketNotices,
} from "./ticket-notices";
import {
  buildReplyClaimsClient,
  claimReply,
  isReplyClaimed,
  replyClaimBlobName,
} from "./reply-claims";

// Default shared mailbox to send agent replies from when customFields.inbox is absent.
const DEFAULT_INBOX = "escape@corespecialty.com";

type TicketPayload = TicketUpdatedPayload;
type TicketEvents = TicketUpdatedPayload["payload"]["events"];
type TicketEvent = TicketEvents[number];

/** The message the webhook's action carries, plus the event it came from (for source/claim keys). */
type EmailableSelection = { text: string; event: TicketEvent };

export async function helpdesk(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const { step, stepError } = createStepLogger(context);

  // The three webhook-driven audiences are independent. The webhook is dark only when all three
  // are off; otherwise tickets.create still patches customFields.email so submitter replies work
  // for tickets created while that audience was disabled. Dev and Prod share one Helpdesk account,
  // so each webhook toggle must be enabled in at most one environment or recipients are duplicated.
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

  const graph = await createGraphClientFromEnv();

  /**
   * Assigned-agent and follower / people-in-the-loop notices. Deliberately BEFORE the requester-
   * specific gates below (email-sourced skip, non-agent skip, missing customFields.email return) —
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
        helpdesk: createHelpdeskClient(),
        payload,
        mailbox: payload.payload.customFields?.inbox ?? DEFAULT_INBOX,
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
   * tickets.create (from the Helpdesk UI): patch the requester email into customFields, and email
   * the requester only when SUBMITTER_REPLIES is on and the create's last event is an agent reply.
   * Customer-emails-in are client-authored and already handled by the inbound worker, so they are
   * not echoed back. The patch runs whenever the webhook is not dark, independent of the submitter
   * toggle, so a ticket created during a notices-only phase is ready when submitter replies turn on.
   */
  if (
    payload.eventType === "tickets.create" &&
    payload.payload.source.detailedSource === "helpdesk"
  ) {
    // Best-effort, like the update branch below: never let this throw. A throw here returns 500,
    // Helpdesk retries the webhook, and sendAgentReply runs again — a DUPLICATE email to the
    // requester (the send is not idempotent). Log and move on instead.
    try {
      const email = (payload.payload.requester.email ?? "").trim();
      await patchCustomFields(createHelpdeskClient(), payload.payload.ID, { email });

      if (!submitterOn) {
        step("Create: requester email patched; submitter replies disabled");
      } else {
        const selection = selectEmailableAgentMessage(events);
        if (selection) {
          await sendAgentReplyOnce(
            graph,
            payload,
            selection,
            email || payload.payload.customFields.email,
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
   * action carries (the last event, or a message immediately behind same-action assignment/status
   * companions) and requires it to be agent-authored and public — a standalone status change,
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
    if (!payload.payload.customFields.email) {
      step("Update: no requester email in custom fields; skipping");
      return { body: "No email found in custom fields, not sending email" };
    }

    await sendAgentReplyOnce(
      graph,
      payload,
      selection,
      payload.payload.customFields.email,
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
 * exception is an agent reply whose action also auto-assigned the ticket (or auto-changed its
 * status), where the message sits behind trailing assignment/status companions and qualifies only
 * within the same-action time window — without that, a reply on an unassigned ticket was silently
 * dropped until the agent assigned themselves and resent. Whatever event is selected must itself
 * be agent-authored AND carry a public, non-system-note, non-blank message.
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
  payload: TicketPayload,
  selection: EmailableSelection,
  toEmail: string,
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

  const sent = await sendAgentReply(graph, payload, selection.text, toEmail, step);
  if (sent) step("Agent reply emailed", { ticketId, eventId });

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
 * Email the requester an agent reply (text only) from the ticket's shared mailbox.
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
  step: StepFn
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
    mailbox: payload.payload.customFields.inbox ?? DEFAULT_INBOX,
    to: toEmail,
    subject,
    body,
  });
  return true;
}
