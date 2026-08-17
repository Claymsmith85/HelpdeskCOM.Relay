// Per-(ticket, message-event) create-once claims for webhook-driven emails: the requester-facing
// agent reply (helpdesk.ts) and the notice-pass fan-out (ticket-notices.ts), each under its own
// blob-name namespace.
//
// The Helpdesk webhook can surface the SAME message event more than once: a redelivery, or a
// reply whose action also auto-assigned the ticket (the message event arrives with a trailing
// assignment/status companion event, and the shared companion-skip selection can meet the same
// message again on a later metadata webhook). A tiny blob records that a message event's email(s)
// already went out, so no selection heuristic can double-email anyone. The claims are best-effort
// by design — both consumers prefer sending over blocking when storage is unavailable (losing a
// customer-facing reply or a notice is worse than a rare duplicate; contrast alerts.ts, which
// fails closed because a duplicate digest is worse than a late one).
import { AxiosInstance } from "axios";
import { blobExists, buildStorageClient, claimCreateOnceBlob } from "./storage-client";

const HTTP_TIMEOUT_MS = 10_000;

/** Default shared state container; override when claim blobs need an isolated container. */
export function replyClaimContainer(): string {
  return (process.env.REPLY_CLAIM_CONTAINER ?? "").trim() || "relay-state";
}

/**
 * Stable blob name for one ticket/event pair (requester reply namespace). Both ids are opaque
 * Helpdesk values: preserved exactly (no case folding), `_` separator — the chat-archive
 * convention for external ids.
 */
export function replyClaimBlobName(ticketId: string, eventId: string): string {
  return `agent-reply-${ticketId}_${eventId}`;
}

/**
 * Stable blob name for one message event's notice-pass fan-out (followers/cc/assigned agent) —
 * a separate namespace from the requester reply, because the audiences send independently.
 */
export function noticeClaimBlobName(ticketId: string, eventId: string): string {
  return `ticket-notice-${ticketId}_${eventId}`;
}

/** Build one authenticated storage client for a webhook invocation. */
export async function buildReplyClaimsClient(): Promise<AxiosInstance> {
  return buildStorageClient({ timeoutMs: HTTP_TIMEOUT_MS, errorPrefix: "reply-claims" });
}

/** Check whether a message event's requester email was already sent. Storage failures propagate. */
export async function isReplyClaimed(client: AxiosInstance, name: string): Promise<boolean> {
  return blobExists(client, replyClaimContainer(), name);
}

/**
 * Record a sent requester email. Returns false when the create-once blob already exists.
 */
export async function claimReply(
  client: AxiosInstance,
  name: string,
  detailJson: string
): Promise<boolean> {
  return claimCreateOnceBlob(client, replyClaimContainer(), name, detailJson);
}
