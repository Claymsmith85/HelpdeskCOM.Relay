// src/functions/storage-client.ts
// Shared Azure Blob Storage REST client (axios + the user-assigned managed identity).
//
// Extracted from drain-lock.ts so more than one caller can talk to the AzureWebJobsStorage account
// without each re-deriving the endpoint/token: drain-lock.ts takes per-mailbox blob leases, while
// alerts.ts and mail-claims.ts use the create-once/existence/delete primitives below. Auth is the
// SAME identity the runtime already uses for identity-based AzureWebJobsStorage, so the storage
// RBAC (Blob Data Contributor) is already in place — no new grant is needed for a new caller.
//
// WHY REST (not @azure/storage-blob): the codebase talks to Azure over raw axios (graph-mail.ts,
// sharepoint.ts) and avoids the heavy Azure SDKs. See drain-lock.ts's header for the full rationale.
import axios, { AxiosError, AxiosInstance } from "axios";
import { DefaultAzureCredential } from "@azure/identity";
import { attachRetryInterceptor } from "./http-retry";

// Storage REST API version. Lease + conditional-PUT semantics are stable across versions; this is
// just a recent one.
export const STORAGE_API_VERSION = "2023-11-03";
export const STORAGE_SCOPE = "https://storage.azure.com/.default";

export type StorageClientOptions = {
  timeoutMs: number;
  // Prefixes thrown error messages so a failure names the subsystem that hit it.
  errorPrefix: string;
  // Optional per-caller override for the account name (drain-lock honours DRAIN_LOCK_ACCOUNT_NAME).
  accountName?: string;
};

function blobPath(container: string, blob: string): string {
  return `/${container}/${encodeURIComponent(blob)}`;
}

/** Read Azure Storage's machine-readable error code from a response header or XML body. */
function storageErrorCode(error: unknown): string | undefined {
  const response = (error as AxiosError)?.response;
  const headers = response?.headers as
    | { get?: (name: string) => unknown; [name: string]: unknown }
    | undefined;
  const fromHeader = headers?.get?.("x-ms-error-code") ?? headers?.["x-ms-error-code"];
  if (typeof fromHeader === "string" && fromHeader) return fromHeader;

  const body = response?.data;
  if (typeof body === "string") {
    return /<Code>([^<]+)<\/Code>/i.exec(body)?.[1];
  }
  return undefined;
}

function isStorageError(error: unknown, status: number, ...codes: string[]): boolean {
  return (
    (error as AxiosError)?.response?.status === status &&
    codes.includes(storageErrorCode(error) ?? "")
  );
}

// One process-mail invocation reuses one Axios client for many claims. Memoize the container ensure
// promise per client/container so the warm path does not emit an expected 409 for every message.
// A rejected ensure is removed so a later call can retry rather than caching a transient failure.
const containerEnsures = new WeakMap<AxiosInstance, Map<string, Promise<void>>>();

async function ensureContainer(client: AxiosInstance, container: string): Promise<void> {
  let byContainer = containerEnsures.get(client);
  if (!byContainer) {
    byContainer = new Map<string, Promise<void>>();
    containerEnsures.set(client, byContainer);
  }

  let pending = byContainer.get(container);
  if (!pending) {
    pending = (async () => {
      try {
        await client.put(`/${container}?restype=container`);
      } catch (e) {
        if (!isStorageError(e, 409, "ContainerAlreadyExists")) throw e;
      }
    })();
    byContainer.set(container, pending);
  }

  try {
    await pending;
  } catch (e) {
    if (byContainer.get(container) === pending) byContainer.delete(container);
    throw e;
  }
}

/**
 * Atomically create a block blob if it does not already exist.
 *
 * Returns true when this call created the blob and false when another call already created it.
 * Container creation is deliberately idempotent: a fresh deployment creates it on first use,
 * while the normal already-exists response is treated as success. All unexpected storage errors
 * propagate so callers can fail closed.
 */
export async function claimCreateOnceBlob(
  client: AxiosInstance,
  container: string,
  blob: string,
  body: string
): Promise<boolean> {
  await ensureContainer(client, container);

  try {
    await client.put(blobPath(container, blob), body, {
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "If-None-Match": "*",
        "Content-Type": "application/json",
      },
    });
    return true;
  } catch (e) {
    if (
      isStorageError(e, 409, "BlobAlreadyExists") ||
      isStorageError(e, 412, "ConditionNotMet")
    ) {
      return false;
    }
    throw e;
  }
}

/** Return whether a blob exists. Only Blob/ContainerNotFound is mapped to false. */
export async function blobExists(
  client: AxiosInstance,
  container: string,
  blob: string
): Promise<boolean> {
  try {
    await client.head(blobPath(container, blob));
    return true;
  } catch (e) {
    if (isStorageError(e, 404, "BlobNotFound", "ContainerNotFound")) return false;
    throw e;
  }
}

/** Delete a blob if present. A missing blob/container is already the desired state. */
export async function deleteBlobIfExists(
  client: AxiosInstance,
  container: string,
  blob: string
): Promise<void> {
  try {
    await client.delete(blobPath(container, blob));
  } catch (e) {
    if (!isStorageError(e, 404, "BlobNotFound", "ContainerNotFound")) throw e;
  }
}

/**
 * Build the storage REST client: baseURL = the blob service endpoint, app-only bearer token from
 * the user-assigned managed identity (the same identity the runtime uses for AzureWebJobsStorage),
 * and the required x-ms-version / x-ms-date headers. Built per call (tokens are long-lived and the
 * credential caches them; the cost is one cached-credential call).
 */
export async function buildStorageClient(opts: StorageClientOptions): Promise<AxiosInstance> {
  const { timeoutMs, errorPrefix } = opts;

  const account = process.env.AzureWebJobsStorage__accountName ?? opts.accountName;
  const serviceUri =
    process.env.AzureWebJobsStorage__blobServiceUri ??
    (account ? `https://${account}.blob.core.windows.net` : undefined);
  if (!serviceUri) {
    throw new Error(
      `${errorPrefix}: storage account not configured (set AzureWebJobsStorage__accountName or AzureWebJobsStorage__blobServiceUri)`
    );
  }

  // The UAMI used for identity-based AzureWebJobsStorage (falls back to the relay's MI client id).
  const clientId =
    process.env.AzureWebJobsStorage__clientId ?? process.env.MANAGED_IDENTITY_CLIENT_ID;
  const cred = new DefaultAzureCredential(
    clientId ? { managedIdentityClientId: clientId } : undefined
  );
  const token = await cred.getToken(STORAGE_SCOPE);
  if (!token?.token) throw new Error(`${errorPrefix}: failed to acquire storage token`);

  const client = axios.create({
    baseURL: serviceUri,
    timeout: timeoutMs,
    headers: {
      Authorization: `Bearer ${token.token}`,
      "x-ms-version": STORAGE_API_VERSION,
    },
  });
  // Stamp a fresh x-ms-date per request (storage requires it; the client can outlive a single call —
  // drain-lock's renewal timer reuses it for the whole drain).
  client.interceptors.request.use((cfg) => {
    cfg.headers.set("x-ms-date", new Date().toUTCString());
    return cfg;
  });
  return attachRetryInterceptor(client, { apiName: "Azure Blob Storage" });
}
