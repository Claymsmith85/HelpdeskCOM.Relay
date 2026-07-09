// src/functions/logging.ts
// Shared structured logging for the function handlers: a step logger with elapsed timing +
// invocationId, plus an optional buffered logger so the (error-only) debug email can include
// the full log stream. No module-load side effects (type-only import of InvocationContext).
import type { InvocationContext } from "@azure/functions";
import type { AxiosError } from "axios";

export type StepFn = (name: string, data?: any) => void;
export type StepErrorFn = (name: string, err: any, data?: any) => void;

/**
 * Safe JSON.stringify wrapper (never throws; falls back to String()).
 */
export function safeJson(v: any): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// The API's own error body is the only thing that explains a 4xx (e.g. Helpdesk's 422 on
// POST /agents). The Functions host logs an object with util.inspect's default depth of 2, so a
// nested body renders as the useless `responseData: { error: [Object] }` — the reason is dropped
// exactly when it's needed. Serialize it to a string so it always survives at any depth. Cap it so
// a large HTML error page can't flood the log stream.
const MAX_RESPONSE_DATA_CHARS = 2000;

function formatResponseData(data: unknown): string | undefined {
  if (data === undefined || data === null) return undefined;
  const s = safeJson(data);
  return s.length > MAX_RESPONSE_DATA_CHARS
    ? `${s.slice(0, MAX_RESPONSE_DATA_CHARS)}…[truncated ${s.length - MAX_RESPONSE_DATA_CHARS} chars]`
    : s;
}

/**
 * Normalize an Axios/Error into a compact, log-friendly object. `responseData` is a JSON *string*
 * (not the raw object) so the host's depth-limited inspect can never elide the server's reason.
 */
export function formatAxiosError(e: any): any {
  const ax = e as AxiosError;
  return {
    message: ax?.message ?? String(e),
    name: ax?.name,
    code: (ax as any)?.code,
    status: ax?.response?.status,
    statusText: ax?.response?.statusText,
    url: (ax as any)?.config?.url,
    method: (ax as any)?.config?.method,
    responseData: formatResponseData(ax?.response?.data),
  };
}

/**
 * Replace context.log with a buffered logger so a debug email can include the log stream.
 * Returns the buffer plus an attach function (call it once to start buffering).
 */
export function createBufferedLogger(context: InvocationContext) {
  const logBuffer = { value: "" };

  // Wrap a log sink so every line is also appended to the buffer (for the debug email).
  function buffered(orig: (...args: any[]) => void) {
    return (...args: any[]) => {
      const message = args
        .map((a) => (typeof a === "string" ? a : safeJson(a)))
        .join(" ");
      logBuffer.value += message + "\n";
      orig.apply(context, args);
    };
  }

  function attachBufferedLogger() {
    // Capture info, warning, AND error so the (error-only) debug email includes the full stream
    // even though stepError now routes through the higher-severity context.error sink.
    context.log = buffered(context.log.bind(context));
    if (context.warn) context.warn = buffered(context.warn.bind(context));
    if (context.error) context.error = buffered(context.error.bind(context));
  }

  return { logBuffer, attachBufferedLogger };
}

/**
 * Structured step logger with elapsed timing, function name, and invocationId.
 *
 * Each line is `[level] [functionName] [invocationId] [+elapsedMs] name`. Levels map to real
 * App Insights severityLevels via the InvocationContext sinks: step -> info, stepWarn -> warning,
 * stepError -> error. That lets you query/alert on `traces | where severityLevel >= 3` instead of
 * grepping a text prefix. (context.warn/error fall back to context.log under a bare test double.)
 */
export function createStepLogger(context: InvocationContext): {
  step: StepFn;
  stepWarn: StepFn;
  stepError: StepErrorFn;
} {
  const t0 = Date.now();
  const inv = context.invocationId;
  const fn = context.functionName;
  const prefix = (level: string, ms: number) => `[${level}] [${fn}] [${inv}] [+${ms}ms]`;

  function step(name: string, data?: any) {
    const ms = Date.now() - t0;
    const line = `${prefix("info", ms)} ${name}`;
    if (data === undefined) context.log(line);
    else context.log(line, data);
  }

  function stepWarn(name: string, data?: any) {
    const ms = Date.now() - t0;
    const line = `${prefix("warn", ms)} ${name}`;
    const sink = context.warn ?? context.log;
    if (data === undefined) sink.call(context, line);
    else sink.call(context, line, data);
  }

  function stepError(name: string, err: any, data?: any) {
    const ms = Date.now() - t0;
    const payload = { ...(data ?? {}), error: formatAxiosError(err) };
    const sink = context.error ?? context.log;
    sink.call(context, `${prefix("error", ms)} ${name}`, payload);
  }

  return { step, stepWarn, stepError };
}
