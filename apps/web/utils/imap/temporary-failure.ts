import { APICallError, RetryError } from "ai";

const TEMPORARY_STATUS_CODES = new Set([
  408, 409, 425, 429, 500, 502, 503, 504,
]);
const TEMPORARY_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const TEMPORARY_MESSAGES = [
  /fetch failed/i,
  /overloaded/i,
  /rate limit/i,
  /too many requests/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /timed? ?out/i,
];

/**
 * True when processing failed because something was briefly unreachable, such
 * as an AI provider that is overloaded or rate limited, or a dropped
 * connection. Trying the same message later can succeed, so such a failure
 * should not count towards giving up on it.
 */
export function isTemporaryFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);

    if (APICallError.isInstance(current)) {
      if (
        current.statusCode !== undefined &&
        TEMPORARY_STATUS_CODES.has(current.statusCode)
      ) {
        return true;
      }
      if (current.statusCode === undefined && current.isRetryable) return true;
    }

    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && TEMPORARY_NETWORK_CODES.has(code)) {
      return true;
    }

    if (current instanceof Error && !APICallError.isInstance(current)) {
      const { message } = current;
      if (TEMPORARY_MESSAGES.some((pattern) => pattern.test(message))) {
        return true;
      }
    }

    current = RetryError.isInstance(current)
      ? current.lastError
      : (current as { cause?: unknown }).cause;
  }

  return false;
}
