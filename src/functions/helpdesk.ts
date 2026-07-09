// src/functions/helpdesk.ts
// Helpdesk webhook handler. On a UI-authored tickets.create it patches the decoded requester
// email and (only for agent replies) emails the requester; on tickets.update it emails the
// requester for agent-authored, non-email, non-private, non-system-note events. Outbound mail
// goes through Graph sendMail from the shared mailbox. See README "Helpdesk Webhook Flow".
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
import { decodeRequesterEmail, hashDomain } from "./requester-hash";
import { shouldSuppressRecipient } from "./routing";
import { createStepLogger, type StepFn } from "./logging";
import { ticketingEnabled } from "./env";

// Default shared mailbox to send agent replies from when customFields.inbox is absent.
const DEFAULT_INBOX = "escape@corespecialty.com";

// "System note:" comments are never emailed to the requester.
const isSystemNoteText = (t?: string) =>
  typeof t === "string" && /(^|\n)\s*System note:/i.test(t);

type TicketPayload = TicketUpdatedPayload;
type TicketEvents = TicketUpdatedPayload["payload"]["events"];

export async function helpdesk(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const { step, stepError } = createStepLogger(context);

  // Master mail-flow switch (TICKETING_TOGGLE). When OFF (the default), the webhook does nothing:
  // no customFields patch, no agent-reply email. Return 200 so Helpdesk treats delivery as handled
  // and does not retry.
  if (!ticketingEnabled()) {
    step("Ticketing disabled (TICKETING_TOGGLE off) — skipping webhook; no email/ticket update");
    // Explicit 200 (load-bearing): Helpdesk treats delivery as handled and does NOT retry the webhook.
    return { status: 200, body: "Ticketing disabled" };
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
   * tickets.create (from the Helpdesk UI): patch the decoded requester email, and email the
   * requester only when the create's last event is an agent reply. Customer-emails-in are
   * client-authored and already handled by the inbound worker, so they are not echoed back.
   */
  if (
    payload.eventType === "tickets.create" &&
    payload.payload.source.detailedSource === "helpdesk"
  ) {
    // Best-effort, like the update branch below: never let this throw. A throw here returns 500,
    // Helpdesk retries the webhook, and sendAgentReply runs again — a DUPLICATE email to the
    // requester (the send is not idempotent). Log and move on instead.
    try {
      const email = decodeRequesterEmail(payload.payload.requester.email, hashDomain());
      await patchCustomFields(createHelpdeskClient(), payload.payload.ID, { email });

      const text = selectEmailableAgentMessage(events);
      if (text) {
        await sendAgentReply(graph, payload, text, email || payload.payload.customFields.email, step);
        step("Create: agent reply emailed");
      } else {
        step("Create: nothing emailable (client-authored / private / system note)");
      }
    } catch (e) {
      stepError("Create: error handling tickets.create (ignored)", e, {
        ticketId: payload.payload.ID,
      });
    }
  }

  /**
   * tickets.update gates: only agent-authored, non-email events reach the send.
   */
  if (payload.eventType !== "tickets.update") {
    return { body: "Not a ticket update event" };
  }
  if (events?.at(-1)?.source?.type === "email") {
    step("Update: email-sourced event already handled inbound; skipping");
    return { body: "Received an email event - already handled by the inbound webhook" };
  }
  if (events?.at(-1)?.author?.type !== "agent") {
    step("Update: non-agent event; skipping");
    return { body: "Received a non agent event - already handled by the inbound webhook" };
  }

  /**
   * tickets.update agent branch.
   */
  try {
    if (!payload.payload.customFields.email) {
      step("Update: no requester email in custom fields; skipping");
      return { body: "No email found in custom fields, not sending email" };
    }

    const text = selectEmailableAgentMessage(events);
    if (text) {
      await sendAgentReply(graph, payload, text, payload.payload.customFields.email, step);
      step("Update: agent reply emailed");
    } else {
      step("Update: nothing visible to email; skipping");
    }
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

/**
 * The text to email the requester, or null if this event must not be emailed.
 * Shared by the create and update branches: requires an agent-authored last event that is not
 * a system note and not private, then returns the last user-visible message text.
 */
function selectEmailableAgentMessage(events: TicketEvents): string | null {
  const last = events?.at(-1);
  if (last?.author?.type !== "agent") return null;
  if (isSystemNoteText(last?.message?.text)) return null;
  if (last?.message?.text && last.message.isPrivate) return null;

  const lastVisible = events
    .filter(
      (e) => e.message?.text && !e.message.isPrivate && !isSystemNoteText(e.message.text)
    )
    .at(-1);
  return lastVisible?.message?.text ?? null;
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
): Promise<void> {
  if (shouldSuppressRecipient(toEmail)) {
    step("Agent reply skipped: recipient is an in-scope/monitored address (loop guard)", { toEmail });
    return;
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
}
