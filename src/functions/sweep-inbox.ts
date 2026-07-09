// src/functions/sweep-inbox.ts
// Timer-triggered safety-net sweep. The inbound drain (process-mail) is otherwise ONLY triggered
// by a live Graph change notification, so any window where notification DELIVERY breaks — a
// lapsed/recreated subscription, a Graph delivery outage, the APIM/WAF dropping the POSTs, or the
// app being down past the subscription TTL — strands mail in the inbox until the next fresh
// notification happens to arrive (which, if delivery is broken, may be never). This timer enqueues
// one "drain this mailbox" item per configured mailbox so outstanding mail is picked up within
// MAIL_SWEEP_CRON regardless of notification delivery, and on every restart (runOnStartup) so a
// reboot immediately catches up on whatever arrived while the app was down.
//
// Cheap + idempotent by construction: the heavy lifting and the move-to-processed idempotency live
// in process-mail, so when notifications are healthy the inbox is already drained and each sweep is
// just a light id-only listing per mailbox that finds nothing.
import { app, InvocationContext, Timer } from "@azure/functions";
import { mailboxList } from "./subscriptions";
import { createStepLogger } from "./logging";
import { mailQueueOutput, type MailQueueItem } from "./mail-queue";

// Enqueues onto the SAME queue process-mail drains (mirrors notify.ts + the continuation drain).
const sweepQueueOutput = mailQueueOutput();

export async function sweepInbox(
  _timer: Timer,
  context: InvocationContext
): Promise<void> {
  const { step, stepWarn } = createStepLogger(context);

  const mailboxes = mailboxList();
  if (mailboxes.length === 0) {
    stepWarn("Sweep: MAILBOX_ADDRESSES is empty; nothing to enqueue");
    return;
  }

  // A sweep item carries only the mailbox (no specific messageId): process-mail treats it as
  // "drain this mailbox's whole inbox".
  const items = mailboxes.map((mailbox): string =>
    JSON.stringify({ mailbox } satisfies MailQueueItem)
  );
  context.extraOutputs.set(sweepQueueOutput, items);
  step("Sweep: enqueued a drain per mailbox", { mailboxes: mailboxes.length });
}

app.timer("sweep-inbox", {
  // Every 15 minutes by default — the worst-case latency before stranded mail is picked up if
  // notification delivery has silently broken. runOnStartup makes a restart catch up immediately.
  schedule: process.env.MAIL_SWEEP_CRON ?? "0 */15 * * * *",
  runOnStartup: true,
  extraOutputs: [sweepQueueOutput],
  handler: sweepInbox,
});
