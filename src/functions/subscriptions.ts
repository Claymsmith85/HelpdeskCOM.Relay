// src/functions/subscriptions.ts
// Microsoft Graph change-notification subscription lifecycle for the native shared mailboxes.
// Message subscriptions expire after ~4230 min (≈2.9 days), so a timer renews them well
// inside that window (see renew-subscriptions.ts).
import { createGraphClientFromEnv } from "./graph-client";
import { formatAxiosError } from "./logging";
import { requireEnv } from "./env";

// 60h: comfortably under the ~70.5h Graph maximum for message resources.
const MESSAGE_SUBSCRIPTION_TTL_MS = 1000 * 60 * 60 * 60;

type GraphSubscription = {
  id: string;
  resource: string;
  notificationUrl: string;
  expirationDateTime: string;
};

/**
 * The shared mailboxes to subscribe, from MAILBOX_ADDRESSES (comma-separated).
 */
export function mailboxList(): string[] {
  return (process.env.MAILBOX_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Inbox messages resource path for a mailbox.
 */
export function inboxResource(mailbox: string): string {
  return `/users/${mailbox}/mailFolders('inbox')/messages`;
}

/**
 * Per-mailbox notification URL: the base GRAPH_NOTIFICATION_URL with the mailbox address appended as
 * a `mailbox` query param. Graph delivers each subscription's notifications to this exact URL, so
 * `notify` can read the configured SMTP address from its own query string and enqueue THAT — instead
 * of the objectId GUID Graph puts in the notification `resource`, which the worker can't resolve to
 * an address without directory permission. (Proven viable: Graph's `validationToken` query param
 * already reaches `notify` through APIM, so a `mailbox` param does too.)
 */
export function notificationUrlForMailbox(baseUrl: string, mailbox: string): string {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}mailbox=${encodeURIComponent(mailbox)}`;
}

/**
 * Create or renew one `created` subscription per configured mailbox.
 * Idempotent: an existing subscription for the same resource + notificationUrl is renewed
 * (PATCH expiration) rather than duplicated.
 *
 * Each mailbox is isolated: a failure on one is logged and counted, then the loop continues so a
 * single bad mailbox can't starve the others of renewal (which would silently let their
 * subscriptions lapse). If ANY mailbox failed, the function throws at the end so the timer
 * invocation is marked failed (and visible/alertable) — but only after every mailbox was tried.
 */
export async function ensureSubscriptions(
  log?: (...args: any[]) => void
): Promise<{ created: number; renewed: number; failed: number; mailboxes: number }> {
  const notificationUrl = requireEnv("GRAPH_NOTIFICATION_URL");
  const clientState = requireEnv("GRAPH_SUBSCRIPTION_CLIENT_STATE");
  const mailboxes = mailboxList();

  const graph = await createGraphClientFromEnv(log);

  const existing =
    (await graph.get<{ value: GraphSubscription[] }>("/subscriptions")).data
      ?.value ?? [];

  const expirationDateTime = new Date(
    Date.now() + MESSAGE_SUBSCRIPTION_TTL_MS
  ).toISOString();

  let created = 0;
  let renewed = 0;
  let failed = 0;

  for (const mailbox of mailboxes) {
    const resource = inboxResource(mailbox);
    const perMailboxUrl = notificationUrlForMailbox(notificationUrl, mailbox);
    const forResource = existing.filter((s) => sameResource(s.resource, resource));
    const match = forResource.find((s) => s.notificationUrl === perMailboxUrl);
    // Any OTHER subscription for this inbox is stale (e.g. an older base-URL one created before the
    // per-mailbox URL): delete it so the mailbox has exactly one subscription. A lingering stale sub
    // would keep delivering notifications with no `mailbox` param, re-triggering the unresolvable-GUID
    // path until it expired (~2.9 days). Guard: only delete subs whose notificationUrl is a form of
    // THIS environment's GRAPH_NOTIFICATION_URL (the base — host + subscription-key — is env-unique),
    // so if the Graph app registration is ever shared across environments we never delete the other
    // env's subscription.
    const stale = forResource.filter(
      (s) => s.id !== match?.id && (s.notificationUrl ?? "").startsWith(notificationUrl)
    );

    try {
      if (match) {
        await graph.patch(`/subscriptions/${match.id}`, { expirationDateTime });
        renewed++;
        log?.("Subscription renewed", { mailbox, id: match.id });
      } else {
        await graph.post("/subscriptions", {
          changeType: "created",
          notificationUrl: perMailboxUrl,
          resource,
          expirationDateTime,
          clientState,
        });
        created++;
        log?.("Subscription created", { mailbox });
      }
    } catch (e) {
      failed++;
      log?.("Subscription ensure FAILED (continuing with remaining mailboxes)", {
        mailbox,
        error: formatAxiosError(e),
      });
      continue; // don't delete stale subs if we couldn't establish the new one
    }

    // Best-effort cleanup of stale subscriptions for this inbox, isolated so a delete failure can't
    // fail the renewal we just succeeded at.
    for (const s of stale) {
      try {
        await graph.delete(`/subscriptions/${s.id}`);
        log?.("Stale subscription deleted", { mailbox, id: s.id });
      } catch (e) {
        log?.("Stale subscription delete failed (continuing)", {
          mailbox,
          id: s.id,
          error: formatAxiosError(e),
        });
      }
    }
  }

  log?.("Subscriptions ensured", { created, renewed, failed, mailboxes: mailboxes.length });
  if (failed > 0) {
    throw new Error(
      `ensureSubscriptions: ${failed} of ${mailboxes.length} mailbox(es) failed to create/renew`
    );
  }
  return { created, renewed, failed, mailboxes: mailboxes.length };
}

/**
 * Compare two Graph resource paths ignoring a leading slash and case.
 */
function sameResource(a: string | undefined, b: string): boolean {
  const norm = (s: string) => (s ?? "").replace(/^\//, "").toLowerCase();
  return norm(a ?? "") === norm(b);
}
