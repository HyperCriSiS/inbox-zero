import { describe, expect, it, vi } from "vitest";
import {
  buildImapOptions,
  buildTlsOptions,
  ImapConnectionPolicyError,
  type ImapConfig,
  resolveEndpointAddress,
} from "@/utils/imap/connection";

vi.mock("@/env", () => ({
  env: { IMAP_ALLOW_PRIVATE_HOSTS: false, IMAP_ALLOW_PLAINTEXT: false },
}));

const STRICT = { allowPrivateHosts: false, allowPlaintext: false };

function endpoint(host: string, security: "tls" | "starttls" | "none" = "tls") {
  return { host, port: 993, security };
}

function config(security: "tls" | "starttls" | "none"): ImapConfig {
  return {
    emailAccountId: "account",
    imap: endpoint("imap.example.com", security),
    smtp: endpoint("smtp.example.com", security),
    username: "user",
    password: "secret",
  };
}

describe("resolveEndpointAddress", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.1",
    "169.254.169.254",
    "[::1]",
  ])("rejects the private address %s", async (host) => {
    await expect(
      resolveEndpointAddress(endpoint(host), STRICT),
    ).rejects.toBeInstanceOf(ImapConnectionPolicyError);
  });

  it("allows a private address when the operator opted in", async () => {
    await expect(
      resolveEndpointAddress(endpoint("127.0.0.1"), {
        allowPrivateHosts: true,
        allowPlaintext: false,
      }),
    ).resolves.toBe("127.0.0.1");
  });

  it("rejects plaintext unless the operator opted in", async () => {
    await expect(
      resolveEndpointAddress(endpoint("8.8.8.8", "none"), STRICT),
    ).rejects.toBeInstanceOf(ImapConnectionPolicyError);
  });
});

describe("buildImapOptions", () => {
  it("requires STARTTLS so a stripped capability cannot downgrade to plaintext", () => {
    expect(buildImapOptions(config("starttls"), "1.2.3.4")).toMatchObject({
      secure: false,
      doSTARTTLS: true,
    });
  });

  it("connects to the checked address but verifies the original host name", () => {
    expect(buildImapOptions(config("tls"), "1.2.3.4")).toMatchObject({
      host: "1.2.3.4",
      servername: "imap.example.com",
      secure: true,
    });
  });
});

describe("buildTlsOptions", () => {
  it("never disables certificate validation", () => {
    expect(buildTlsOptions("host", null).rejectUnauthorized).toBe(true);
    expect(buildTlsOptions("host", "PEM").rejectUnauthorized).toBe(true);
  });

  it("trusts only the pinned certificate", () => {
    expect(buildTlsOptions("host", "PEM").ca).toBe("PEM");
  });
});
