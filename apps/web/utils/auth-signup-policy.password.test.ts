import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPasswordLoginEnabled } from "./auth-signup-policy";

const env = vi.hoisted(() => ({
  NEXT_PUBLIC_AUTH_PASSWORD_ENABLED: false,
  AUTH_ALLOWED_EMAILS: [] as string[],
  AUTH_ALLOWED_EMAIL_DOMAINS: [] as string[],
}));

vi.mock("@/env", () => ({ env }));

describe("isPasswordLoginEnabled", () => {
  beforeEach(() => {
    env.NEXT_PUBLIC_AUTH_PASSWORD_ENABLED = true;
    env.AUTH_ALLOWED_EMAILS = [];
    env.AUTH_ALLOWED_EMAIL_DOMAINS = [];
  });

  it("stays off without an allowlist, since addresses are not verified", () => {
    expect(isPasswordLoginEnabled()).toBe(false);
  });

  it("turns on with an allowed email or domain", () => {
    env.AUTH_ALLOWED_EMAILS = ["me@example.com"];
    expect(isPasswordLoginEnabled()).toBe(true);

    env.AUTH_ALLOWED_EMAILS = [];
    env.AUTH_ALLOWED_EMAIL_DOMAINS = ["example.com"];
    expect(isPasswordLoginEnabled()).toBe(true);
  });

  it("stays off when the flag is not set", () => {
    env.NEXT_PUBLIC_AUTH_PASSWORD_ENABLED = false;
    env.AUTH_ALLOWED_EMAILS = ["me@example.com"];

    expect(isPasswordLoginEnabled()).toBe(false);
  });
});
