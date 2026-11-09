import { describe, expect, it } from "vitest";
import {
  diffFlags,
  diffMailbox,
  getScanStartUid,
  type IndexedMessage,
  isSecondCopyOfOwnMail,
  isSyncableFolder,
  matchMovedMessages,
  planMailboxSync,
  shouldEnqueueForRules,
} from "@/utils/imap/sync-plan";

describe("getScanStartUid", () => {
  it("starts at the oldest indexed message", () => {
    expect(
      getScanStartUid({
        indexed: [row(900), row(700), row(800)],
        lastSeenUid: BigInt(900),
        liveUidValidity: BigInt(1),
      }),
    ).toBe(BigInt(700));
  });

  it("ignores rows from an older UIDVALIDITY", () => {
    expect(
      getScanStartUid({
        indexed: [row(5, { uidValidity: BigInt(9) }), row(700)],
        lastSeenUid: BigInt(700),
        liveUidValidity: BigInt(1),
      }),
    ).toBe(BigInt(700));
  });

  it("starts after the last seen UID when nothing is indexed", () => {
    expect(
      getScanStartUid({
        indexed: [],
        lastSeenUid: BigInt(41),
        liveUidValidity: BigInt(1),
      }),
    ).toBe(BigInt(42));
  });
});

describe("isSyncableFolder", () => {
  it("skips virtual folders flagged in LIST without SPECIAL-USE", () => {
    expect(isSyncableFolder({ flags: new Set(["\\All"]) })).toBe(false);
    expect(isSyncableFolder({ flags: new Set(["\\Flagged"]) })).toBe(false);
  });

  it("skips folders that cannot be selected", () => {
    expect(isSyncableFolder({ flags: new Set(["\\Noselect"]) })).toBe(false);
  });

  it("keeps ordinary folders", () => {
    expect(
      isSyncableFolder({ flags: new Set(["\\Sent"]), specialUse: "\\Sent" }),
    ).toBe(true);
  });
});

function row(uid: number, overrides: Partial<IndexedMessage> = {}) {
  return {
    id: `row-${uid}`,
    flags: [],
    uid: BigInt(uid),
    uidValidity: BigInt(1),
    objectId: null,
    rfc822MessageId: `${uid}@x`,
    ...overrides,
  };
}

function incoming(uid: number, rfc822MessageId: string | null = `${uid}@x`) {
  return { uid: BigInt(uid), objectId: null, rfc822MessageId };
}

const STORED = {
  uidValidity: BigInt(1),
  lastSeenUid: BigInt(10),
  highestModseq: BigInt(5),
};

describe("planMailboxSync", () => {
  it("takes a baseline for an unknown mailbox", () => {
    expect(planMailboxSync(null, { uidValidity: BigInt(1), uidNext: 5 })).toBe(
      "baseline",
    );
  });

  it("resets when UIDVALIDITY changed", () => {
    expect(
      planMailboxSync(STORED, { uidValidity: BigInt(2), uidNext: 11 }),
    ).toBe("reset");
  });

  it("is idle only when MODSEQ proves nothing changed", () => {
    expect(
      planMailboxSync(STORED, {
        uidValidity: BigInt(1),
        uidNext: 11,
        highestModseq: BigInt(5),
      }),
    ).toBe("idle");
  });

  it("still compares UIDs without MODSEQ, since deletions keep UIDNEXT", () => {
    expect(
      planMailboxSync(STORED, { uidValidity: BigInt(1), uidNext: 11 }),
    ).toBe("incremental");
  });
});

describe("diffMailbox", () => {
  const base = {
    mode: "incremental" as const,
    lastSeenUid: BigInt(10),
    liveUidValidity: BigInt(1),
  };

  it("does not report the highest UID as new when nothing arrived", () => {
    const result = diffMailbox({
      ...base,
      serverUids: [BigInt(9), BigInt(10)],
      indexed: [row(9), row(10)],
    });

    expect(result).toEqual({ newUids: [], vanished: [] });
  });

  it("finds new and vanished messages", () => {
    const result = diffMailbox({
      ...base,
      serverUids: [BigInt(10), BigInt(12), BigInt(11)],
      indexed: [row(9), row(10)],
    });

    expect(result.newUids).toEqual([BigInt(11), BigInt(12)]);
    expect(result.vanished.map((message) => message.id)).toEqual(["row-9"]);
  });

  it("does not index old UIDs that were never in the baseline window", () => {
    const result = diffMailbox({
      ...base,
      serverUids: [BigInt(2), BigInt(10)],
      indexed: [row(10)],
    });

    expect(result.newUids).toEqual([]);
  });

  it("treats every row of an old UIDVALIDITY as vanished on reset", () => {
    const result = diffMailbox({
      ...base,
      mode: "reset",
      liveUidValidity: BigInt(2),
      serverUids: [BigInt(1)],
      indexed: [row(1)],
    });

    expect(result.newUids).toEqual([BigInt(1)]);
    expect(result.vanished).toHaveLength(1);
  });
});

describe("matchMovedMessages", () => {
  it("keeps the app ID of a message moved to another mailbox", () => {
    const result = matchMovedMessages([row(1)], [incoming(77, "1@x")]);

    expect(result.moved).toHaveLength(1);
    expect(result.moved[0].from.id).toBe("row-1");
    expect(result.created).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it("prefers OBJECTID over a reused Message-ID", () => {
    const wrong = row(1, { objectId: "other", rfc822MessageId: "same@x" });
    const right = row(2, { objectId: "obj", rfc822MessageId: "same@x" });

    const result = matchMovedMessages(
      [wrong, right],
      [{ uid: BigInt(9), objectId: "obj", rfc822MessageId: "same@x" }],
    );

    expect(result.moved[0].from.id).toBe("row-2");
  });

  it("pairs each vanished row once when copies share a Message-ID", () => {
    const result = matchMovedMessages(
      [row(1, { rfc822MessageId: "same@x" })],
      [incoming(8, "same@x"), incoming(9, "same@x")],
    );

    expect(result.moved).toHaveLength(1);
    expect(result.created).toHaveLength(1);
  });

  it("never matches two messages without a Message-ID", () => {
    const result = matchMovedMessages(
      [row(1, { rfc822MessageId: null })],
      [incoming(8, null)],
    );

    expect(result.moved).toEqual([]);
    expect(result.deleted).toHaveLength(1);
    expect(result.created).toHaveLength(1);
  });
});

describe("shouldEnqueueForRules", () => {
  it("runs rules for new inbox and sent mail", () => {
    for (const role of ["inbox", "sent"] as const) {
      expect(
        shouldEnqueueForRules({
          mode: "incremental",
          role,
          isSecondCopyOfOwnMail: false,
        }),
      ).toBe(true);
    }
  });

  it.each([
    ["baseline", "inbox", false],
    ["reset", "inbox", false],
    ["incremental", "junk", false],
    ["incremental", null, false],
    ["incremental", "inbox", true],
  ] as const)("skips mode=%s role=%s copy=%s", (mode, role, copy) => {
    expect(
      shouldEnqueueForRules({ mode, role, isSecondCopyOfOwnMail: copy }),
    ).toBe(false);
  });
});

describe("isSecondCopyOfOwnMail", () => {
  it("recognizes mail to oneself in Sent and the inbox", () => {
    expect(isSecondCopyOfOwnMail("inbox", ["sent"])).toBe(true);
    expect(isSecondCopyOfOwnMail("sent", ["inbox"])).toBe(true);
  });

  it("does not trust a Message-ID that is only known from received mail", () => {
    expect(isSecondCopyOfOwnMail("inbox", ["inbox", "archive", null])).toBe(
      false,
    );
    expect(isSecondCopyOfOwnMail("inbox", ["trash", "junk"])).toBe(false);
  });
});

describe("diffFlags", () => {
  it("reports flags changed by another client, in any order", () => {
    const indexed = [
      row(1, { flags: ["\\Seen", "\\Flagged"] }),
      row(2, { flags: [] }),
    ];

    expect(
      diffFlags(indexed, [
        { uid: BigInt(1), flags: ["\\Flagged", "\\Seen"] },
        { uid: BigInt(2), flags: ["\\Seen"] },
      ]),
    ).toEqual([{ id: "row-2", flags: ["\\Seen"] }]);
  });

  it("ignores messages that are not indexed", () => {
    expect(diffFlags([], [{ uid: BigInt(9), flags: [] }])).toEqual([]);
  });
});
