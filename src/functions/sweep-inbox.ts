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
// Idempotency lives in process-mail: handled mail is either moved to processed (drain on) or left in
// place behind a storage claim (drain off). In drain-off mode a sweep still pays the bounded id-only
// listing + claim-HEAD cost, but it does not repeat ticket or acknowledgement side effects.
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
  // "scan this mailbox for bounded outstanding/claimed work".
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
