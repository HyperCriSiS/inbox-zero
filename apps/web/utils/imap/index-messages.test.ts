import { describe, expect, it, vi } from "vitest";
import { storedFlags } from "@/utils/imap/index-messages";

vi.mock("@/utils/prisma");

describe("storedFlags", () => {
  it("drops the per-session recent flag", () => {
    expect(storedFlags(new Set(["\\Seen", "\\Recent", "iz_Work"]))).toEqual([
      "\\Seen",
      "iz_Work",
    ]);
  });
});
