// Operator-only startup recovery for a stale notification backlog. The queue contains drain hints,
// not the source mail, so clearing it is safe only when explicitly enabled; sweep-inbox then
// reconstructs one current drain per mailbox. The poison queue is deliberately never touched.
import { app } from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";
import axios, { AxiosError, AxiosInstance } from "axios";
import { envFlag } from "./env";
import { attachRetryInterceptor } from "./http-retry";
import { formatAxiosError } from "./logging";
import { MAIL_QUEUE_NAME } from "./mail-queue";
import { STORAGE_API_VERSION, STORAGE_SCOPE } from "./storage-client";

// Language workers have a fixed startup budget. Keep the entire auth + clear path below it and
// make only one HTTP attempt; if Azure reports OperationTimedOut, the next worker start safely
// repeats this idempotent operation while the recovery switch remains enabled.
const CLEAR_REQUEST_TIMEOUT_MS = 30_000;
const CLEAR_STARTUP_TIMEOUT_MS = 45_000;

type StartupLog = Pick<Console, "info" | "error">;
type ClearResult = "cleared" | "not-found";

type StartupOptions = {
  createClient?: () => Promise<AxiosInstance>;
  log?: StartupLog;
};

function queueServiceUriFromEnv(): string {
  const explicit = (process.env.AzureWebJobsStorage__queueServiceUri ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const account = (process.env.AzureWebJobsStorage__accountName ?? "").trim();
  if (account) return `https://${account}.queue.core.windows.net`;

  throw new Error(
    "clear-mail-queue: queue storage not configured " +
      "(set AzureWebJobsStorage__queueServiceUri or AzureWebJobsStorage__accountName)"
  );
}

function queueErrorCode(error: unknown): string | undefined {
  const response = (error as AxiosError)?.response;
  const headers = response?.headers as
    | { get?: (name: string) => unknown; [name: string]: unknown }
    | undefined;
  const fromHeader = headers?.get?.("x-ms-error-code") ?? headers?.["x-ms-error-code"];
  if (typeof fromHeader === "string" && fromHeader) return fromHeader;

  const body = response?.data;
  if (typeof body === "string") return /<Code>([^<]+)<\/Code>/i.exec(body)?.[1];
  return undefined;
}

/** Build an Entra-authenticated client for the AzureWebJobsStorage Queue endpoint. */
export async function createQueueStorageClient(): Promise<AxiosInstance> {
  const baseURL = queueServiceUriFromEnv();
  const storageClientId = (process.env.AzureWebJobsStorage__clientId ?? "").trim();
  const fallbackClientId = (process.env.MANAGED_IDENTITY_CLIENT_ID ?? "").trim();
  const clientId = storageClientId || fallbackClientId;
  const startupSignal = AbortSignal.timeout(CLEAR_STARTUP_TIMEOUT_MS);
  const credential = new DefaultAzureCredential(
    clientId ? { managedIdentityClientId: clientId } : undefined
  );
  const token = await credential.getToken(STORAGE_SCOPE, { abortSignal: startupSignal });
  if (!token?.token) {
    throw new Error("clear-mail-queue: failed to acquire Azure Queue Storage token");
  }

  const client = axios.create({
    baseURL,
    timeout: CLEAR_REQUEST_TIMEOUT_MS,
    signal: startupSignal,
    headers: {
      Authorization: `Bearer ${token.token}`,
      "x-ms-version": STORAGE_API_VERSION,
    },
  });
  client.interceptors.request.use((config) => {
    config.headers.set("x-ms-date", new Date().toUTCString());
    return config;
  });
  return attachRetryInterceptor(client, {
    apiName: "Azure Queue Storage",
    maxRetries: 0,
  });
}

/** Clear only the primary mail queue. Missing is already the desired state. */
export async function clearMailQueue(client: AxiosInstance): Promise<ClearResult> {
  const path = `/${encodeURIComponent(MAIL_QUEUE_NAME)}/messages`;

  try {
    await client.delete(path);
    return "cleared";
  } catch (error) {
    const status = (error as AxiosError)?.response?.status;
    if (status === 404 && queueErrorCode(error) === "QueueNotFound") return "not-found";
    throw error;
  }
}

/** Awaited app-start hook. When enabled, failure aborts startup instead of consuming stale work. */
export async function clearMailQueueOnStartup(opts: StartupOptions = {}): Promise<void> {
  if (!envFlag(process.env.MAIL_QUEUE_CLEAR_ON_STARTUP, false)) return;

  const log = opts.log ?? console;
  try {
    const client = await (opts.createClient ?? createQueueStorageClient)();
    const result = await clearMailQueue(client);
    log.info("[startup] Azure Queue Storage primary mail queue clear complete", {
      queue: MAIL_QUEUE_NAME,
      result,
    });
  } catch (error) {
    log.error("[startup] Azure Queue Storage primary mail queue clear FAILED", {
      queue: MAIL_QUEUE_NAME,
      error: formatAxiosError(error),
    });
    throw error;
  }
}

app.hook.appStart(() => clearMailQueueOnStartup());
