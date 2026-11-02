import { describe, expect, it } from "vitest";
import {
  assignThreads,
  parseMessageIds,
  resolveThread,
} from "@/utils/imap/thread";

const NO_THREADS = new Map<string, string>();

function resolve(
  headers: { messageId?: string; references?: string; inReplyTo?: string },
  knownThreadIds: ReadonlyMap<string, string> = NO_THREADS,
  childThreadIds: string[] = [],
) {
  return resolveThread({
    messageId: headers.messageId,
    references: headers.references,
    inReplyTo: headers.inReplyTo,
    fallbackKey: "mailbox:1:1",
    knownThreadIds,
    childThreadIds,
  });
}

describe("parseMessageIds", () => {
  it("extracts bracketed IDs and ignores surrounding text", () => {
    expect(parseMessageIds("<a@x> comment\r\n <b@x>")).toEqual(["a@x", "b@x"]);
  });

  it("accepts bare IDs", () => {
    expect(parseMessageIds("a@x b@x")).toEqual(["a@x", "b@x"]);
  });
});

describe("resolveThread", () => {
  it("puts a root message and its reply in the same thread", () => {
    const root = resolve({ messageId: "<root@x>" });
    const reply = resolve({
      messageId: "<reply@x>",
      references: "<root@x>",
      inReplyTo: "<root@x>",
    });

    expect(reply.threadId).toBe(root.threadId);
  });

  it("keeps the thread when only In-Reply-To of a later reply is known", () => {
    const known = new Map([["reply@x", "thread-1"]]);

    const result = resolve(
      { messageId: "<reply2@x>", inReplyTo: "<reply@x>" },
      known,
    );

    expect(result.threadId).toBe("thread-1");
  });

  it("adopts the thread of a reply synced before its parent", () => {
    const result = resolve({ messageId: "<root@x>" }, NO_THREADS, ["thread-1"]);

    expect(result).toEqual({ threadId: "thread-1", mergeThreadIds: [] });
  });

  it("reports threads to merge when a message connects two of them", () => {
    const known = new Map([
      ["a@x", "thread-1"],
      ["b@x", "thread-2"],
    ]);

    const result = resolve(
      { messageId: "<c@x>", references: "<a@x> <b@x>" },
      known,
    );

    expect(result).toEqual({
      threadId: "thread-1",
      mergeThreadIds: ["thread-2"],
    });
  });

  it("never groups messages without a Message-ID", () => {
    const first = resolveThread({
      messageId: undefined,
      references: undefined,
      inReplyTo: undefined,
      fallbackKey: "inbox:1:1",
      knownThreadIds: NO_THREADS,
    });
    const second = resolveThread({
      messageId: undefined,
      references: undefined,
      inReplyTo: undefined,
      fallbackKey: "inbox:1:2",
      knownThreadIds: NO_THREADS,
    });

    expect(first.threadId).not.toBe(second.threadId);
  });
});

describe("assignThreads", () => {
  function input(messageId: string, references?: string) {
    return {
      messageId,
      references: references ?? null,
      inReplyTo: null,
      fallbackKey: messageId,
    };
  }

  it("joins a parent scanned after its reply", () => {
    const { threadIds } = assignThreads(
      [input("<reply@x>", "<root@x>"), input("<root@x>")],
      [],
    );

    expect(threadIds[0]).toBe(threadIds[1]);
  });

  it("joins an indexed thread through a stored reference", () => {
    const { threadIds } = assignThreads(
      [input("<root@x>")],
      [
        {
          rfc822MessageId: "reply@x",
          references: ["root@x"],
          threadId: "thread-1",
        },
      ],
    );

    expect(threadIds).toEqual(["thread-1"]);
  });

  it("merges two threads and rewrites earlier batch results", () => {
    const { threadIds, merges } = assignThreads(
      [input("<a@x>"), input("<b@x>"), input("<c@x>", "<a@x> <b@x>")],
      [],
    );

    expect(new Set(threadIds).size).toBe(1);
    expect(merges.size).toBe(1);
  });
});
