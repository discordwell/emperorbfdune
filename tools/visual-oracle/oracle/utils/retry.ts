/**
 * Retry an async function with exponential backoff.
 * Retries on 429 (rate limit), 500+, and network errors.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  label: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      const status = e?.status ?? e?.error?.status ?? 0;
      const isRetryable = status === 429 || status >= 500 || e?.code === 'ECONNRESET' || e?.code === 'ETIMEDOUT' || e?.message?.includes('overloaded');
      if (!isRetryable || attempt === maxRetries) throw e;
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30000);
      console.warn(`${label} API error (status=${status}), retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}
