import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { isTemporaryFailure } from "./temporary-failure";

function apiError(statusCode: number | undefined, isRetryable = false) {
  return new APICallError({
    message: "Provider error",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: {},
    statusCode,
    isRetryable,
  });
}

describe("isTemporaryFailure", () => {
  it.each([429, 500, 502, 503, 504])("treats HTTP %i as temporary", (code) => {
    expect(isTemporaryFailure(apiError(code))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])("treats HTTP %i as permanent", (code) => {
    expect(isTemporaryFailure(apiError(code))).toBe(false);
  });

  it("looks through exhausted AI SDK retries", () => {
    const error = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [apiError(503)],
    });
    expect(isTemporaryFailure(error)).toBe(true);
  });

  it("detects dropped connections in the cause chain", () => {
    const cause = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
    expect(isTemporaryFailure(new Error("fetch failed", { cause }))).toBe(true);
  });

  it("detects an overloaded provider by its message", () => {
    expect(isTemporaryFailure(new Error("Overloaded"))).toBe(true);
  });

  it("does not retry broken messages or bad keys", () => {
    expect(isTemporaryFailure(new Error("Cannot read properties"))).toBe(false);
    expect(isTemporaryFailure(apiError(401))).toBe(false);
    expect(isTemporaryFailure(undefined)).toBe(false);
  });
});
