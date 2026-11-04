import { describe, expect, it, vi } from "vitest";
import { parseVCardContacts } from "./contacts";

vi.mock("@/utils/prisma");
vi.mock("@/env", () => ({
  env: { IMAP_ALLOW_PRIVATE_HOSTS: false, IMAP_ALLOW_PLAINTEXT: false },
}));

describe("parseVCardContacts", () => {
  it("reads every address of a card with its name", () => {
    const card = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Ana Example",
      "EMAIL;TYPE=WORK:ana@example.org",
      "EMAIL;TYPE=HOME:mailto:ana@home.example",
      "END:VCARD",
    ].join("\r\n");

    expect(parseVCardContacts(card)).toEqual([
      { emailAddress: "ana@example.org", name: "Ana Example" },
      { emailAddress: "ana@home.example", name: "Ana Example" },
    ]);
  });

  it("skips cards without an address and keeps nameless ones", () => {
    const cards = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:No Mail",
      "TEL:+491234",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:4.0",
      "EMAIL:solo@example.org",
      "END:VCARD",
    ].join("\r\n");

    expect(parseVCardContacts(cards)).toEqual([
      { emailAddress: "solo@example.org" },
    ]);
  });
});
