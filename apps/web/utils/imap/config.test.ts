import { describe, expect, it, vi } from "vitest";
import { isAuthenticationFailure } from "./config";

vi.mock("@/utils/prisma");

describe("isAuthenticationFailure", () => {
  it("is true for a rejected password", () => {
    expect(
      isAuthenticationFailure({
        authenticationFailed: true,
        serverResponseCode: "AUTHENTICATIONFAILED",
      }),
    ).toBe(true);
    expect(isAuthenticationFailure({ authenticationFailed: true })).toBe(true);
  });

  it("is false when the server could not check the login right now", () => {
    for (const serverResponseCode of ["UNAVAILABLE", "INUSE", "LIMIT"]) {
      expect(
        isAuthenticationFailure({
          authenticationFailed: true,
          serverResponseCode,
        }),
      ).toBe(false);
    }
  });

  it("is false for other errors", () => {
    expect(isAuthenticationFailure(new Error("socket closed"))).toBe(false);
    expect(isAuthenticationFailure(null)).toBe(false);
  });
});
