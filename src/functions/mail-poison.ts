// src/functions/mail-poison.ts
// Observability for dead-lettered drains. When a `process-mail` queue item exceeds host.json's
// maxDequeueCount, the Functions runtime moves it to "<queue>-poison" and otherwise drops it
// silently. This trigger fires on that poison queue and logs the item at ERROR severity so it
// surfaces in App Insights (`traces | where severityLevel >= 3`) and can drive an alert, instead
// of the relay failing quietly. It only logs — it deliberately does NOT reprocess (the item
// failed repeatedly for a reason); the periodic sweep (sweep-inbox) will re-derive any mail still
// sitting in the inbox, so a poisoned item is not lost, just flagged.
import { app, InvocationContext } from "@azure/functions";
import { createStepLogger, safeJson } from "./logging";
import { MAIL_QUEUE_POISON_NAME } from "./mail-queue";

export async function mailPoison(
  queueItem: unknown,
  context: InvocationContext
): Promise<void> {
  const { stepError } = createStepLogger(context);
  stepError(
    "Drain item POISONED — exceeded maxDequeueCount and was dead-lettered; the sweep will re-derive any mail still in the inbox, but investigate the repeated failure",
    new Error("poison-queue message"),
    { queueItem: safeJson(queueItem) }
  );
}

app.storageQueue("mail-poison", {
  queueName: MAIL_QUEUE_POISON_NAME,
  connection: "AzureWebJobsStorage",
  handler: mailPoison,
});
