// src/functions/graph-mail.ts
// Microsoft Graph mail I/O — the SendGrid replacement. Reads inbound messages and their
// attachments from the native shared mailboxes, sends outbound mail (acks / agent replies /
// error-only debug) via `sendMail`, and moves processed messages for idempotency.
import { AxiosError, AxiosInstance } from "axios";
import { GRAPH_TRANSFER_TIMEOUT_MS } from "./graph-client";

// #region Public Types

/** Normalized inbound message (Graph equivalent of the old SendGrid InboundParsed). */
export type InboundMessage = {
  subject: string;
  fromAddress: string;
  fromName: string | null;
  toAddress: string | null;
  text: string;
  replyTo: string | null;
  attachmentsCount: number;
  receivedDateTime: string | null; // ISO-8601 from Graph; used for the ignore-before-cutoff guard
};

/** A file attachment's metadata (no bytes) — enough for the size/ignore policy. */
export type AttachmentInfo = {
  id: string;
  name: string;
  size: number;
  contentType: string; // lower-cased
  isInline: boolean;
};

export type AttachmentMeta = { filename: string; size: number };

// #endregion

// #region Graph message shapes

type GraphRecipient = { emailAddress?: { name?: string; address?: string } };

export type GraphMessage = {
  id: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
  hasAttachments?: boolean;
  receivedDateTime?: string;
};

type GraphAttachment = {
  "@odata.type"?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
};

const MESSAGE_SELECT =
  "id,subject,from,sender,toRecipients,replyTo,body,bodyPreview,hasAttachments,receivedDateTime";

// #endregion

// #region Inbound (read)

/**
 * Fetch a single message. Requests a plain-text body via the Prefer header (mirrors SendGrid's
 * `text` field) — the full body, entire quoted thread included, is what reaches the ticket.
 */
export async function getMessage(
  graph: AxiosInstance,
  mailbox: string,
  messageId: string
): Promise<GraphMessage> {
  const res = await graph.get<GraphMessage>(
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(
      messageId
    )}?$select=${MESSAGE_SELECT}`,
    { headers: { Prefer: 'outlook.body-content-type="text"' } }
  );
  return res.data;
}

/**
 * Map a Graph message into the normalized inbound shape used by the worker.
 */
export function parseGraphMessage(msg: GraphMessage): InboundMessage {
  const from = msg.from?.emailAddress ?? msg.sender?.emailAddress ?? {};
  const reply = msg.replyTo?.[0]?.emailAddress;
  const to = msg.toRecipients?.[0]?.emailAddress;
  return {
    subject: (msg.subject ?? "").trim(),
    fromAddress: (from.address ?? "").trim(),
    fromName: from.name?.trim() || null,
    toAddress: to?.address?.trim() ?? null,
    text: msg.body?.content ?? msg.bodyPreview ?? "",
    replyTo: reply?.address?.trim() ?? null,
    attachmentsCount: msg.hasAttachments ? 1 : 0, // hint only; the real count comes from listMessageAttachments
    receivedDateTime: msg.receivedDateTime?.trim() || null,
  };
}

/**
 * Shared id-only, oldest-first, paged listing of a mail-folder resource. `$select=id` keeps the
 * response light no matter how large the messages' attachments are; paging follows
 * `@odata.nextLink` until `max` ids are collected. `folderResource` is the folder's addressing
 * segment — the well-known `mailFolders('inbox')` or a `mailFolders/{id}` path.
 *
 * `receivedAfterIso` (optional, ISO-8601 UTC) restricts the listing to mail received at/after the
 * cutoff via a server-side `$filter=receivedDateTime ge ...`. Because the listing is `$orderby`ed
 * by the SAME property, Graph accepts the combination (it rejects $filter+$orderby on *different*
 * properties).
 */
async function listFolderMessageIdsByResource(
  graph: AxiosInstance,
  mailbox: string,
  folderResource: string,
  max: number,
  receivedAfterIso?: string
): Promise<string[]> {
  const ids: string[] = [];
  let url: string | null =
    `/users/${encodeURIComponent(mailbox)}/${folderResource}/messages` +
    `?$select=id&$orderby=receivedDateTime asc&$top=50` +
    (receivedAfterIso ? `&$filter=receivedDateTime ge ${receivedAfterIso}` : "");

  while (url && ids.length < max) {
    const res: { data: { value?: { id: string }[]; "@odata.nextLink"?: string } } =
      await graph.get(url);
    for (const m of res.data?.value ?? []) {
      if (m?.id) ids.push(m.id);
      if (ids.length >= max) break;
    }
    url = ids.length < max ? res.data?.["@odata.nextLink"] ?? null : null;
  }

  return ids;
}

/**
 * List the ids of messages currently in a mailbox's **inbox folder**, oldest-first. Uses the same
 * `mailFolders('inbox')` resource the subscription targets (see subscriptions.ts) — so this is
 * exactly the set of "outstanding" mail (handled mail is moved out to the processed folder). Used
 * by the worker to drain the whole inbox on each notification, catching anything whose
 * notification was dropped (e.g. an app reboot).
 *
 * `receivedAfterIso` is how the drain ignores a pre-go-live backlog: old mail is never even listed,
 * so it is left untouched in the inbox rather than ticketed/auto-replied. Oldest-first ordering
 * means that without the filter the drain would otherwise process the OLDEST mail first.
 */
export function listInboxMessageIds(
  graph: AxiosInstance,
  mailbox: string,
  max: number,
  receivedAfterIso?: string
): Promise<string[]> {
  return listFolderMessageIdsByResource(
    graph,
    mailbox,
    "mailFolders('inbox')",
    max,
    receivedAfterIso
  );
}

/**
 * List the ids of messages in an arbitrary mail folder **by folder id**, oldest-first. Used by the
 * reprocess drain: messages an admin drops into the Reprocess folder are replayed through the
 * inbound pipeline as if newly arrived. Deliberately takes NO `receivedAfterIso` — reprocess
 * bypasses the ignore-before cutoff (the whole point of moving old mail into Reprocess is to force
 * it through).
 */
export function listFolderMessageIds(
  graph: AxiosInstance,
  mailbox: string,
  folderId: string,
  max: number
): Promise<string[]> {
  return listFolderMessageIdsByResource(
    graph,
    mailbox,
    `mailFolders/${encodeURIComponent(folderId)}`,
    max
  );
}

/**
 * List a message's file attachments as **metadata only** (no bytes). `$select` keeps the
 * response light even when the message carries large attachments, so the size/ignore policy
 * can run without downloading anything. Item/reference (non-file) attachments are skipped.
 */
export async function listMessageAttachments(
  graph: AxiosInstance,
  mailbox: string,
  messageId: string,
  log?: (...args: any[]) => void
): Promise<AttachmentInfo[]> {
  const res = await graph.get<{ value: GraphAttachment[] }>(
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(
      messageId
    )}/attachments?$select=id,name,size,contentType,isInline`
  );
  const items = res.data?.value ?? [];
  const out: AttachmentInfo[] = [];

  for (const a of items) {
    const odataType = (a["@odata.type"] ?? "").toLowerCase();
    if (odataType && !odataType.includes("fileattachment")) {
      log?.("Attachment skipped (not a file attachment)", {
        name: a.name,
        type: a["@odata.type"],
      });
      continue;
    }
    out.push({
      id: a.id,
      name: a.name ?? "attachment",
      size: typeof a.size === "number" ? a.size : 0,
      contentType: (a.contentType ?? "").toLowerCase(),
      isInline: !!a.isInline,
    });
  }

  return out;
}

/**
 * Fetch a single attachment's raw bytes via `/$value` (no base64). The caller uploads one
 * attachment at a time, so peak memory is bounded to the largest single file, not the sum —
 * BUT the whole file is buffered here (not streamed), so across concurrent invocations the heap
 * high-water mark is roughly host.json's queue `batchSize` × the largest in-flight file. That is
 * why `batchSize` is kept low; truly streaming Graph -> SharePoint would remove the ceiling
 * entirely. Uses the longer transfer timeout since large downloads are legitimately slow.
 */
export async function fetchAttachmentBytes(
  graph: AxiosInstance,
  mailbox: string,
  messageId: string,
  attachmentId: string
): Promise<Buffer> {
  const res = await graph.get(
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(
      messageId
    )}/attachments/${attachmentId}/$value`,
    {
      responseType: "arraybuffer",
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: GRAPH_TRANSFER_TIMEOUT_MS,
    }
  );
  return Buffer.from(res.data as ArrayBuffer);
}

const mailboxAddressCache = new Map<string, string>();

/**
 * Resolve the primary SMTP address for a mailbox id/UPN (used for team routing).
 * Best-effort: returns null on failure so the caller can fall back to the message `To`.
 */
export async function resolveMailboxAddress(
  graph: AxiosInstance,
  mailbox: string
): Promise<string | null> {
  const cached = mailboxAddressCache.get(mailbox);
  if (cached) return cached;
  try {
    const res = await graph.get<{ mail?: string; userPrincipalName?: string }>(
      `/users/${encodeURIComponent(mailbox)}?$select=mail,userPrincipalName`
    );
    const addr = res.data?.mail ?? res.data?.userPrincipalName ?? null;
    if (addr) mailboxAddressCache.set(mailbox, addr);
    return addr;
  } catch {
    return null;
  }
}

// #endregion

// #region Outbound (send)

/**
 * Send a plain-text email as a shared mailbox via Graph `sendMail`.
 * Requires the app's Mail.Send to be scoped (Application Access Policy) to the mailbox.
 */
export async function sendMailViaGraph(opts: {
  graph: AxiosInstance;
  mailbox: string; // the shared mailbox to send AS (its SMTP is the From)
  to: string;
  subject: string;
  body: string;
  saveToSentItems?: boolean;
}): Promise<void> {
  const { graph, mailbox, to, subject, body, saveToSentItems = true } = opts;
  await graph.post(`/users/${encodeURIComponent(mailbox)}/sendMail`, {
    message: {
      subject,
      body: { contentType: "Text", content: body },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems,
  });
}

/**
 * Send a debug email (gated by SEND_DEBUG_EMAIL=="true"; error-only/opt-in).
 * Caller passes `fromMailbox` as the mailbox the message landed in — the app's Application
 * Access Policy licenses it to send as that shared mailbox.
 */
export async function sendDebugEmail(opts: {
  graph: AxiosInstance;
  fromMailbox: string;
  to: string;
  originalSubject: string;
  debugDump: string;
  logBuffer?: string;
}): Promise<void> {
  if (process.env.SEND_DEBUG_EMAIL !== "true") return;
  const { graph, fromMailbox, to, originalSubject, debugDump, logBuffer } = opts;
  await sendMailViaGraph({
    graph,
    mailbox: fromMailbox,
    to,
    subject: `HDC DEBUG: ${originalSubject}`,
    body: `${debugDump}\n#####################\n${logBuffer ?? ""}`,
  });
}

// #endregion

// #region Idempotency (move processed mail)

const processedFolderCache = new Map<string, string>();

/**
 * Resolve (creating if needed) a top-level mail folder by display name; returns its id.
 * Cached per mailbox.
 */
export async function ensureMailFolder(
  graph: AxiosInstance,
  mailbox: string,
  displayName: string
): Promise<string> {
  const cacheKey = `${mailbox}::${displayName.toLowerCase()}`;
  const cached = processedFolderCache.get(cacheKey);
  if (cached) return cached;

  const wanted = displayName.toLowerCase();
  const findFolderId = async (): Promise<string | null> => {
    const list = await graph.get<{ value: { id: string; displayName: string }[] }>(
      `/users/${encodeURIComponent(mailbox)}/mailFolders?$top=100&$select=id,displayName`
    );
    const found = (list.data?.value ?? []).find(
      (f) => (f.displayName ?? "").toLowerCase() === wanted
    );
    return found?.id ?? null;
  };

  const existing = await findFolderId();
  if (existing) {
    processedFolderCache.set(cacheKey, existing);
    return existing;
  }

  try {
    const created = await graph.post<{ id: string }>(
      `/users/${encodeURIComponent(mailbox)}/mailFolders`,
      { displayName }
    );
    processedFolderCache.set(cacheKey, created.data.id);
    return created.data.id;
  } catch (e) {
    // Concurrent create -> 409 ErrorFolderExists; re-list to find it.
    if ((e as AxiosError)?.response?.status === 409) {
      const match = await findFolderId();
      if (match) {
        processedFolderCache.set(cacheKey, match);
        return match;
      }
    }
    throw e;
  }
}

/**
 * Move a message to a destination folder. Graph assigns the moved copy a NEW id, so any
 * duplicate notification carrying the original id will 404 on getMessage — that 404 is the
 * relay's idempotency signal.
 */
export async function moveMessageToFolder(
  graph: AxiosInstance,
  mailbox: string,
  messageId: string,
  destinationId: string
): Promise<void> {
  await graph.post(
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(
      messageId
    )}/move`,
    { destinationId }
  );
}

// #endregion

