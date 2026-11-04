import { describe, expect, it, vi } from "vitest";
import { createMockEmailProvider } from "@/utils/__mocks__/email-provider";
import { createTestLogger } from "@/__tests__/helpers";
import type { EmailThread } from "@/utils/email/types";
import { cleanUpLabel } from "./run-label-cleanup";

vi.mock("@/utils/prisma");

const logger = createTestLogger();
const olderThan = new Date("2026-10-01T00:00:00Z");
const old = String(new Date("2026-09-01T00:00:00Z").getTime());
const recent = String(new Date("2026-10-20T00:00:00Z").getTime());

function thread(id: string, messages: { date: string; labels: string[] }[]) {
  return {
    id,
    messages: messages.map((message, index) => ({
      id: `${id}-${index}`,
      threadId: id,
      internalDate: message.date,
      labelIds: message.labels,
    })),
  } as unknown as EmailThread;
}

describe("cleanUpLabel", () => {
  it("acts only on old threads that carry the label", async () => {
    const provider = createMockEmailProvider({
      getThreadsWithQuery: vi.fn().mockResolvedValue({
        threads: [
          thread("due", [{ date: old, labels: ["Label_news"] }]),
          thread("replied", [
            { date: old, labels: ["Label_news"] },
            { date: recent, labels: [] },
          ]),
          // A provider that ignored the label filter must not sweep this up.
          thread("unlabeled", [{ date: old, labels: ["INBOX"] }]),
        ],
      }),
    });

    const handled = await cleanUpLabel({
      provider,
      ownerEmail: "me@example.com",
      labelId: "Label_news",
      action: "REMOVE_LABEL",
      olderThan,
      logger,
    });

    expect(handled).toBe(1);
    expect(provider.removeThreadLabel).toHaveBeenCalledTimes(1);
    expect(provider.removeThreadLabel).toHaveBeenCalledWith(
      "due",
      "Label_news",
    );
  });

  it("archives or trashes as configured and follows pages", async () => {
    const provider = createMockEmailProvider({
      getThreadsWithQuery: vi
        .fn()
        .mockResolvedValueOnce({
          threads: [thread("a", [{ date: old, labels: ["L"] }])],
          nextPageToken: "next",
        })
        .mockResolvedValueOnce({
          threads: [thread("b", [{ date: old, labels: ["L"] }])],
        }),
    });

    await cleanUpLabel({
      provider,
      ownerEmail: "me@example.com",
      labelId: "L",
      action: "TRASH",
      olderThan,
      logger,
    });

    expect(provider.trashThread).toHaveBeenCalledWith(
      "a",
      "me@example.com",
      "automation",
    );
    expect(provider.trashThread).toHaveBeenCalledWith(
      "b",
      "me@example.com",
      "automation",
    );
    expect(
      vi.mocked(provider.getThreadsWithQuery).mock.calls[1][0],
    ).toMatchObject({ pageToken: "next" });
  });

  it("keeps going when one thread fails", async () => {
    const provider = createMockEmailProvider({
      getThreadsWithQuery: vi.fn().mockResolvedValue({
        threads: [
          thread("a", [{ date: old, labels: ["L"] }]),
          thread("b", [{ date: old, labels: ["L"] }]),
        ],
      }),
      archiveThread: vi
        .fn()
        .mockRejectedValueOnce(new Error("gone"))
        .mockResolvedValueOnce(undefined),
    });

    await expect(
      cleanUpLabel({
        provider,
        ownerEmail: "me@example.com",
        labelId: "L",
        action: "ARCHIVE",
        olderThan,
        logger,
      }),
    ).resolves.toBe(1);
  });
});
