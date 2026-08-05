// Per-message create-once claims for inbound mail that is handled without being moved.
//
// Moving a message to the processed folder is normally process-mail's idempotency marker: Graph
// assigns the moved item a new id, so the original id disappears. When MAILBOX_DRAIN is off the
// item remains in place, so a tiny blob records that its ticket/ack side effects already ran. The
// opaque Graph message id is preserved exactly; only the mailbox portion is canonicalized.
import { AxiosInstance } from "axios";
import { normalizeMailboxKey } from "./routing";
import {
  blobExists,
  buildStorageClient,
  claimCreateOnceBlob,
  deleteBlobIfExists,
} from "./storage-client";

const HTTP_TIMEOUT_MS = 30_000;

/** Default shared state container; override when claim blobs need an isolated container. */
export function mailClaimContainer(): string {
  return (process.env.MAIL_CLAIM_CONTAINER ?? "").trim() || "relay-state";
}

/**
 * Stable blob name for one mailbox/message pair. Mailbox aliases collapse to the canonical UPN,
 * while the case-sensitive Graph id is deliberately not transformed.
 */
export function messageClaimBlobName(mailboxKey: string, messageId: string): string {
  return `mail-claim-${normalizeMailboxKey(mailboxKey)}-${messageId}`;
}

/** Build one authenticated storage client for a process-mail invocation. */
export async function buildMailClaimsClient(): Promise<AxiosInstance> {
  return buildStorageClient({ timeoutMs: HTTP_TIMEOUT_MS, errorPrefix: "mail-claims" });
}

/** Check the no-move idempotency marker. Storage failures propagate; callers must not act blind. */
export async function isMessageClaimed(client: AxiosInstance, name: string): Promise<boolean> {
  return blobExists(client, mailClaimContainer(), name);
}

/**
 * Record a successfully handled message. Returns false when the create-once blob already exists.
 */
export async function claimMessage(
  client: AxiosInstance,
  name: string,
  detailJson: string
): Promise<boolean> {
  return claimCreateOnceBlob(client, mailClaimContainer(), name, detailJson);
}

/** Release a claim after its message is filed during drain-on catch-up. Missing is success. */
export async function releaseMessageClaim(client: AxiosInstance, name: string): Promise<void> {
  await deleteBlobIfExists(client, mailClaimContainer(), name);
}
