// src/functions/http-retry.ts
// Shared axios retry policy for the Graph + Helpdesk + Storage clients. Graph throttles aggressively
// (429 + Retry-After) and any HTTP boundary can return a transient 503 or drop the connection.
// Without this, a single such blip throws straight out of the pipeline and lands the bounded mailbox
// scan on the queue's coarse retry (which re-lists/rechecks work and ignores Retry-After). This
// absorbs the common transient case in place, honoring Retry-After, before it reaches that
// sledgehammer.
//
// Retry SAFETY is the load-bearing part here — a retry must never duplicate a side effect:
//   - 429 and 503 mean the server explicitly rejected the request WITHOUT processing it, so they
//     are safe to retry for ANY method (including the non-idempotent POST createTicket / sendMail
//     / move).
//   - A transport failure (no response / timeout) or an ambiguous 500/502/504 might have been
//     processed server-side, so we retry those ONLY for idempotent reads (GET/HEAD). Retrying a
//     POST there could create a second ticket or send a second email.
import { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";

export type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  // Stable boundary name carried into terminal error logs (e.g. Helpdesk, Microsoft Graph).
  apiName?: string;
  // Injectable for tests so retries don't actually wait on a real timer.
  sleep?: (ms: number) => Promise<void>;
};

// Defaults for callers that pass no overrides — today the Graph and Storage clients. Kept modest on
// purpose: one blip should cost a few seconds, not minutes, because the mail drain makes several
// Graph and Storage calls per message inside a 10-minute functionTimeout. The Helpdesk client wants
// a deeper ladder and asks for it explicitly (see helpdesk-client.ts), so raising these to suit
// Helpdesk would slow Graph and Storage for no reason.
const DEFAULTS = { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 20_000 };

// Statuses where the server rejected the request before processing it -> safe to retry any method.
const REJECTED_BEFORE_PROCESSING = new Set([429, 503]);
// Ambiguous server errors -> retry only for idempotent reads (the request may have been applied).
const AMBIGUOUS_SERVER_ERRORS = new Set([500, 502, 504]);
const IDEMPOTENT_METHODS = new Set(["get", "head", "options"]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type RetryConfig = AxiosRequestConfig & { __retryCount?: number };
type LabeledAxiosError = AxiosError & { api?: string; retries?: number };

/**
 * Attach a response-error retry interceptor to an axios instance (returns the same instance).
 */
export function attachRetryInterceptor(
  client: AxiosInstance,
  opts: RetryOptions = {}
): AxiosInstance {
  const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const apiName = opts.apiName;
  const sleep = opts.sleep ?? defaultSleep;

  client.interceptors.response.use(undefined, async (error: AxiosError) => {
    const config = error.config as RetryConfig | undefined;
    const labeled = error as LabeledAxiosError;
    if (apiName) {
      labeled.api = apiName;
      const prefix = `[${apiName} API]`;
      if (!labeled.message.startsWith(prefix)) labeled.message = `${prefix} ${labeled.message}`;
    }
    labeled.retries = config?.__retryCount ?? 0;
    if (!config) throw error;

    const attempt = config.__retryCount ?? 0;
    if (attempt >= maxRetries || !isRetryable(error)) throw error;

    config.__retryCount = attempt + 1;
    await sleep(retryDelayMs(error, attempt, baseDelayMs, maxDelayMs));
    return client(config);
  });

  return client;
}

/**
 * Decide whether an axios error is worth retrying under the safety rules above.
 */
export function isRetryable(error: AxiosError): boolean {
  const status = error.response?.status;
  if (status !== undefined && REJECTED_BEFORE_PROCESSING.has(status)) return true;

  const method = (error.config?.method ?? "get").toLowerCase();
  if (!IDEMPOTENT_METHODS.has(method)) return false;

  // Idempotent read: also retry ambiguous 5xx and dispatched-but-failed transport errors.
  if (status !== undefined) return AMBIGUOUS_SERVER_ERRORS.has(status);
  return !!error.request && error.code !== "ERR_CANCELED";
}

/**
 * Delay before the next attempt: honor Retry-After when present, else exponential backoff
 * (baseDelay * 2^attempt) capped at maxDelay, plus a little jitter to avoid a thundering herd.
 */
function retryDelayMs(
  error: AxiosError,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const retryAfter = parseRetryAfter(error.response?.headers?.["retry-after"]);
  if (retryAfter !== null) return Math.min(retryAfter, maxDelayMs);
  const backoff = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  // Clamp the JITTERED total, not just the exponential term. Adding jitter after the cap let the
  // real delay reach maxDelayMs + baseDelayMs, so maxDelayMs did not mean what it says — and the
  // overshoot scaled with baseDelayMs, making the ladder impossible to bound (or to pin in a test)
  // by lowering maxDelayMs alone.
  return Math.min(backoff + Math.floor(Math.random() * baseDelayMs), maxDelayMs);
}

/**
 * Parse a Retry-After header (delta-seconds or an HTTP date) into milliseconds, or null.
 */
export function parseRetryAfter(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const raw = String(Array.isArray(value) ? value[0] : value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}
