// src/functions/renew-subscriptions.ts
// Timer-triggered subscription lifecycle. Graph message subscriptions expire after ~2.9
// days; this runs every 6h to create-or-renew one per configured mailbox so notifications
// never lapse. Trigger it manually once after first deploy to bootstrap the subscriptions
// (Graph validates the notify endpoint during creation).
import { app, InvocationContext, Timer } from "@azure/functions";
import { ensureSubscriptions } from "./subscriptions";
import { createStepLogger } from "./logging";

export async function renewSubscriptions(
  _timer: Timer,
  context: InvocationContext
): Promise<void> {
  const { step, stepError } = createStepLogger(context);
  step("Start: ensure subscriptions");
  try {
    // Forward ensureSubscriptions' per-mailbox log events through the step logger so each
    // create/renew shows up as an explicit, severity-tagged step.
    const result = await ensureSubscriptions((...a: any[]) => step(String(a[0]), a[1]));
    step("Done: subscriptions ensured", result);
  } catch (e) {
    // stepError runs the error through formatAxiosError, surfacing the Graph response body
    // (responseData) + status/url — what you need to diagnose a 403/400 on subscription create —
    // at App Insights severityLevel Error.
    stepError("Failed to ensure subscriptions", e);
    throw e;
  }
}

app.timer("renew-subscriptions", {
  schedule: process.env.SUBSCRIPTION_RENEW_CRON ?? "0 0 */6 * * *",
  // Re-establish subscriptions immediately on every app start: a restart can outlive the
  // subscriptions (they expire after ~2.9 days), and otherwise nothing would recreate them until
  // the next 6h tick — a silent gap where Graph delivers no notifications. ensureSubscriptions is
  // idempotent (create-or-renew) and cheap (a handful of mailboxes), so running it on startup as
  // well as on schedule is safe.
  runOnStartup: true,
  handler: renewSubscriptions,
});
