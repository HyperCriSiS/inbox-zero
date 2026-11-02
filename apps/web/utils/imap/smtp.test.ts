import { describe, expect, it, vi } from "vitest";
import {
  composeMessage,
  parseRecipients,
  stripPrivateHeaders,
} from "@/utils/imap/smtp";

vi.mock("@/env", () => ({
  env: { IMAP_ALLOW_PRIVATE_HOSTS: false, IMAP_ALLOW_PLAINTEXT: false },
}));

describe("composeMessage", () => {
  it("encodes a subject with line breaks instead of adding headers", async () => {
    const { raw } = await composeMessage({
      from: "me@example.com",
      to: "you@example.com",
      subject: "Hi\r\nBcc: evil@example.com",
      text: "x",
    });

    const headers = raw.toString().split("\r\n\r\n")[0];
    expect(headers).not.toMatch(/^bcc:/im);
  });

  it("keeps BCC for stored copies", async () => {
    const { raw } = await composeMessage({
      from: "me@example.com",
      bcc: "hidden@example.com",
      subject: "s",
      text: "x",
    });

    expect(raw.toString()).toContain("hidden@example.com");
  });
});

describe("stripPrivateHeaders", () => {
  it("removes BCC, including folded lines, and leaves the rest intact", () => {
    const raw = Buffer.from(
      "From: a@x\r\nBcc: one@x,\r\n two@x\r\nTo: b@x\r\n\r\nBcc: body text\r\n",
    );

    expect(stripPrivateHeaders(raw).toString()).toBe(
      "From: a@x\r\nTo: b@x\r\n\r\nBcc: body text\r\n",
    );
  });

  it("removes Proton Mail Bridge's internal headers", () => {
    const raw = Buffer.from(
      "X-Pm-Gluon-Id: 1\r\nFrom: a@x\r\nX-Pm-Internal-Id: 2\r\n\r\nbody\r\n",
    );

    expect(stripPrivateHeaders(raw).toString()).toBe(
      "From: a@x\r\n\r\nbody\r\n",
    );
  });

  it("does not leak BCC from a composed message", async () => {
    const { raw } = await composeMessage({
      from: "me@example.com",
      to: "you@example.com",
      bcc: "hidden@example.com",
      subject: "s",
      text: "x",
    });

    expect(stripPrivateHeaders(raw).toString()).not.toContain(
      "hidden@example.com",
    );
  });
});

describe("parseRecipients", () => {
  it("extracts bare addresses from a display list", () => {
    expect(parseRecipients('"Doe, Ana" <ana@x.de>, bob@x.de')).toEqual([
      "ana@x.de",
      "bob@x.de",
    ]);
  });
});
