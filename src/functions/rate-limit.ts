// The mail drain can burst several Helpdesk requests per message, which triggers the API's 429
// limit. Reserve fixed-interval dispatch slots instead of accumulating token-bucket burst credit:
// idle time never permits a new burst, and retries are paced because axios re-enters request
// interceptors when the retry policy dispatches the request again.
import { AxiosInstance } from "axios";

export type RateLimiter = {
  acquire: (intervalMs: number) => Promise<void>;
};

export type RateLimiterOptions = {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Create a process-local fixed-interval request limiter. */
export function createRateLimiter(opts: RateLimiterOptions = {}): RateLimiter {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  let nextSlotAt = 0;

  return {
    async acquire(intervalMs: number): Promise<void> {
      if (!(intervalMs > 0)) return;

      const currentTime = now();
      const slot = Math.max(currentTime, nextSlotAt);
      nextSlotAt = slot + intervalMs;

      if (slot > currentTime) await sleep(slot - currentTime);
    },
  };
}

/** Pace every request dispatched through an axios instance, including retried requests. */
export function attachRateLimitInterceptor(
  client: AxiosInstance,
  limiter: RateLimiter,
  intervalMs: number
): AxiosInstance {
  client.interceptors.request.use(async (config) => {
    await limiter.acquire(intervalMs);
    return config;
  });

  return client;
}
