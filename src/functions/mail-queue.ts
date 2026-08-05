// src/functions/mail-queue.ts
// Shared Storage Queue contract for the inbound mail pipeline. notify (HTTP), sweep-inbox (timer),
// and process-mail's continuation drain all enqueue onto ONE queue that process-mail drains;
// mail-poison reads its dead-letter sibling. Centralizing the queue name, the output binding, and
// the item shape here keeps those four files from drifting — a mismatched queue name would silently
// strand mail. No module-load side effects: the binding is built lazily via mailQueueOutput().
import { output } from "@azure/functions";

// The queue process-mail drains. notify, sweep-inbox, and the continuation drain all enqueue here.
export const MAIL_QUEUE_NAME = process.env.MAIL_QUEUE_NAME ?? "mail-notifications";

// Dead-letter sibling the Functions runtime moves items to after maxDequeueCount; mail-poison reads it.
export const MAIL_QUEUE_POISON_NAME = `${MAIL_QUEUE_NAME}-poison`;

// messageId is optional: the `notify` path always sets it (the changed message), but a sweep item
// (sweep-inbox.ts) carries only a mailbox and means "scan this mailbox for bounded work".
export type MailQueueItem = { mailbox: string; messageId?: string };

/**
 * A Storage Queue output binding pointing at the mail queue. Each enqueuing module calls this once
 * at load and keeps its own binding object (referenced in `extraOutputs` and passed to
 * `context.extraOutputs.set`).
 */
export function mailQueueOutput() {
  return output.storageQueue({
    queueName: MAIL_QUEUE_NAME,
    connection: "AzureWebJobsStorage",
  });
}
