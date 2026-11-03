import { describe, expect, it } from "vitest";
import {
  matchesThreadFilter,
  parseThreadQuery,
} from "@/utils/imap/thread-query";

describe("parseThreadQuery", () => {
  it("defaults to the inbox", () => {
    expect(parseThreadQuery(undefined)).toEqual({
      labels: [],
      role: "inbox",
      starred: false,
      unread: false,
    });
  });

  it("looks for a custom label in every folder", () => {
    expect(parseThreadQuery({ labelId: "Rechnungen" })).toMatchObject({
      labels: ["Rechnungen"],
      role: null,
    });
  });

  it("splits system and custom labels", () => {
    expect(
      parseThreadQuery({ labelIds: ["INBOX", "UNREAD", "Rechnungen"] }),
    ).toEqual({
      labels: ["Rechnungen"],
      role: "inbox",
      starred: false,
      unread: true,
    });
  });

  it("maps query types to folders", () => {
    expect(parseThreadQuery({ type: "sent" }).role).toBe("sent");
    expect(parseThreadQuery({ type: "archive" }).role).toBe("archive");
    expect(parseThreadQuery({ type: "spam" }).role).toBe("junk");
  });

  it("does not narrow the all view to one folder", () => {
    expect(parseThreadQuery({ type: "all" })).toMatchObject({
      labels: [],
      role: null,
    });
  });

  it("treats starred mail as a filter across folders", () => {
    expect(parseThreadQuery({ type: "starred" })).toMatchObject({
      role: null,
      starred: true,
    });
  });

  it("treats an unknown type as a label, like Gmail", () => {
    expect(parseThreadQuery({ type: "Rechnungen" }).labels).toEqual([
      "Rechnungen",
    ]);
  });
});

describe("matchesThreadFilter", () => {
  const message = {
    headers: { from: "Ana <ana@example.org>" },
    internalDate: String(new Date("2026-06-15").getTime()),
    labelIds: ["SENT", "Rechnungen"],
  } as Parameters<typeof matchesThreadFilter>[0];
  const filter = { excludedLabels: [], labels: [], unread: false };

  it("needs every requested label", () => {
    expect(
      matchesThreadFilter(message, { ...filter, labels: ["Rechnungen"] }),
    ).toBe(true);
    expect(
      matchesThreadFilter(message, {
        ...filter,
        labels: ["Rechnungen", "Andere"],
      }),
    ).toBe(false);
  });

  it("drops excluded labels", () => {
    expect(
      matchesThreadFilter(message, {
        ...filter,
        excludedLabels: ["Rechnungen"],
      }),
    ).toBe(false);
  });

  it("applies the sender and date bounds", () => {
    expect(
      matchesThreadFilter(message, { ...filter, fromEmail: "ANA@example.org" }),
    ).toBe(true);
    expect(
      matchesThreadFilter(message, { ...filter, fromEmail: "bob@example.org" }),
    ).toBe(false);
    expect(
      matchesThreadFilter(message, {
        ...filter,
        before: new Date("2026-01-01"),
      }),
    ).toBe(false);
    expect(
      matchesThreadFilter(message, {
        ...filter,
        after: new Date("2026-01-01"),
      }),
    ).toBe(true);
  });

  it("applies unread", () => {
    expect(matchesThreadFilter(message, { ...filter, unread: true })).toBe(
      false,
    );
  });
});
