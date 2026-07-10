// src/functions/storage-client.ts
// Shared Azure Blob Storage REST client (axios + the user-assigned managed identity).
//
// Extracted from drain-lock.ts so more than one caller can talk to the AzureWebJobsStorage account
// without each re-deriving the endpoint/token: drain-lock.ts takes per-mailbox blob leases, and
// seat-alert.ts writes a once-per-day claim blob. Auth is the SAME identity the runtime already
// uses for identity-based AzureWebJobsStorage, so the storage RBAC (Blob Data Contributor) is
// already in place — no new grant is needed for a new caller.
//
// WHY REST (not @azure/storage-blob): the codebase talks to Azure over raw axios (graph-mail.ts,
// sharepoint.ts) and avoids the heavy Azure SDKs. See drain-lock.ts's header for the full rationale.
import axios, { AxiosInstance } from "axios";
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
  return attachRetryInterceptor(client);
}
