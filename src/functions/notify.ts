// src/functions/notify.ts
// HTTP receiver for Microsoft Graph change notifications on the shared-mailbox inboxes.
// Responsibilities are deliberately tiny so it can ack within Graph's ~3s window:
//   1. Answer the subscription validation handshake (echo validationToken).
//   2. Validate clientState and enqueue { mailbox, messageId } for the worker.
// The heavy lifting (fetch message, ticket, SharePoint, sendMail) is in process-mail.ts.
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { createStepLogger } from "./logging";
import { mailQueueOutput, type MailQueueItem } from "./mail-queue";

// #region Types

type GraphNotification = {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  resourceData?: { id?: string };
};

type GraphNotificationBatch = { value?: GraphNotification[] };

// #endregion

const queueOutput = mailQueueOutput();

/**
 * Extract the mailbox id and message id from a notification's `resource`
 * (e.g. "Users/{id}/Messages/{id}"). Message id prefers resourceData.id.
 */
export function parseResource(n: GraphNotification): MailQueueItem | null {
  const m = /users\/([^/]+)\/messages\/([^/?]+)/i.exec(n?.resource ?? "");
  if (!m) return null;
  const mailbox = m[1];
  const messageId = n?.resourceData?.id ?? m[2];
  if (!mailbox || !messageId) return null;
  return { mailbox, messageId };
}

export async function notify(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const { step, stepWarn } = createStepLogger(context);

  // 1) Subscription validation handshake (create/renew): echo the token as text/plain.
  const validationToken = request.query.get("validationToken");
  if (validationToken) {
    step("Validation handshake: echoing token");
    return {
      status: 200,
      headers: { "Content-Type": "text/plain" },
      body: validationToken,
    };
  }

  // 2) Notification batch -> validate + enqueue.
  const expectedClientState = process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE;

  // The mailbox is carried in this subscription's notificationUrl (set per-mailbox in
  // subscriptions.ts), so we enqueue the configured SMTP address rather than Graph's objectId GUID
  // from the resource — the worker canonicalizes an address deterministically but can't resolve the
  // GUID (no directory permission). Each subscription's URL is mailbox-specific, so this one value
  // applies to every notification in the batch. Absent (a subscription created before this change),
  // we fall back to the resource id.
  const mailboxOverride = request.query.get("mailbox") || null;

  let batch: GraphNotificationBatch;
  try {
    batch = (await request.json()) as GraphNotificationBatch;
  } catch {
    stepWarn("No/invalid JSON body; nothing to enqueue");
    return { status: 202 };
  }

  const notifications = batch?.value ?? [];
  step("Notification batch received", { count: notifications.length });

  const messages: string[] = [];
  for (const n of notifications) {
    // Fail closed: require a configured clientState AND an exact match. An unset/empty
    // GRAPH_SUBSCRIPTION_CLIENT_STATE must reject everything, not accept everything.
    if (!expectedClientState || n.clientState !== expectedClientState) {
      stepWarn("clientState missing/mismatch; ignoring notification");
      continue;
    }
    const item = parseResource(n);
    if (!item) {
      stepWarn("Could not parse resource", { resource: n.resource });
      continue;
    }
    messages.push(
      JSON.stringify({ mailbox: mailboxOverride ?? item.mailbox, messageId: item.messageId })
    );
  }

  if (messages.length > 0) {
    context.extraOutputs.set(queueOutput, messages);
    step("Enqueued mail notifications", { count: messages.length });
  } else {
    step("Nothing to enqueue", { received: notifications.length });
  }

  return { status: 202 };
}

app.http("notify", {
  methods: ["POST"],
  authLevel: "anonymous",
  extraOutputs: [queueOutput],
  handler: notify,
});
