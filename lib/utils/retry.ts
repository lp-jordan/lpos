/**
 * Exponential back-off retry helper.
 *
 * Retries up to maxAttempts times with delays of 1s, 2s, 4s, 8s … capped at 16s.
 * By default retries on 429 / 5xx status codes embedded in error messages and on
 * network-level TypeErrors (no response at all).
 *
 * Pass a custom isRetryable to restrict retry behaviour (e.g. only safe methods).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
  isRetryable?: (err: unknown) => boolean,
): Promise<T> {
  const check = isRetryable ?? defaultIsRetryable;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts - 1 || !check(err)) throw err;
      await sleep(Math.min(1_000 * 2 ** attempt, 16_000));
    }
  }
  throw lastErr;
}

function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof TypeError) return true; // network error — no response
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|500|502|503|504)\b/.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
