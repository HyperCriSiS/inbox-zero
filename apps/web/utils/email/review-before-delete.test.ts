import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockEmailProvider } from "@/utils/__mocks__/email-provider";
import type { EmailProvider } from "@/utils/email/types";
import { createTestLogger } from "@/__tests__/helpers";
import { withReviewBeforeDelete } from "./review-before-delete";

const logger = createTestLogger();

describe("withReviewBeforeDelete", () => {
  it("returns the provider unchanged without a review name", () => {
    const provider = createMockEmailProvider();
    expect(withReviewBeforeDelete(provider, undefined, logger)).toBe(provider);
    expect(withReviewBeforeDelete(provider, "  ", logger)).toBe(provider);
  });

  describe("Gmail", () => {
    let provider: EmailProvider;
    let reviewed: EmailProvider;

    beforeEach(() => {
      provider = createMockEmailProvider({
        name: "google",
        getLabelByName: vi.fn().mockResolvedValue(null),
        createLabel: vi
          .fn()
          .mockResolvedValue({ id: "Label_review", name: "Review" }),
      });
      reviewed = withReviewBeforeDelete(provider, "Review", logger);
    });

    it("archives under the review label instead of trashing", async () => {
      await reviewed.trashThread("thread-1", "me@example.com", "automation");

      expect(provider.trashThread).not.toHaveBeenCalled();
      expect(provider.archiveThreadWithLabel).toHaveBeenCalledWith(
        "thread-1",
        "me@example.com",
        "Label_review",
      );
    });

    it("archives under the review label instead of marking spam", async () => {
      await reviewed.markSpam("thread-1");

      expect(provider.markSpam).not.toHaveBeenCalled();
      expect(provider.archiveThreadWithLabel).toHaveBeenCalledWith(
        "thread-1",
        "",
        "Label_review",
      );
    });

    it("creates the label once", async () => {
      await reviewed.trashMessages(["m1"]);
      await reviewed.trashMessages(["m2"]);

      expect(provider.createLabel).toHaveBeenCalledTimes(1);
      expect(provider.trashMessages).not.toHaveBeenCalled();
      expect(provider.archiveMessages).toHaveBeenLastCalledWith(
        ["m2"],
        "Label_review",
      );
    });

    it("undoes by removing the label and unarchiving", async () => {
      await reviewed.untrashThread("thread-1");

      expect(provider.removeThreadLabel).toHaveBeenCalledWith(
        "thread-1",
        "Label_review",
      );
      expect(provider.unarchiveThread).toHaveBeenCalledWith("thread-1");
    });

    it("replaces the TRASH and SPAM system labels in label actions", async () => {
      await reviewed.labelMessage({
        messageId: "m1",
        labelId: "TRASH",
        labelName: "TRASH",
      });
      await reviewed.labelMessage({
        messageId: "m1",
        labelId: "Label_receipts",
        labelName: "Receipts",
      });
      await reviewed.createFilter({
        from: "a@example.com",
        addLabelIds: ["SPAM"],
      });

      expect(provider.labelMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ labelId: "Label_review" }),
      );
      expect(provider.labelMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ labelId: "Label_receipts" }),
      );
      expect(provider.createFilter).toHaveBeenCalledWith({
        from: "a@example.com",
        addLabelIds: ["Label_review"],
      });
    });

    it("moves every page of a sender's mail to review", async () => {
      vi.mocked(provider.getMessagesFromSender)
        .mockResolvedValueOnce({
          messages: [{ id: "m1" }, { id: "m2" }] as any,
          nextPageToken: "page-2",
        })
        .mockResolvedValueOnce({ messages: [{ id: "m3" }] as any });

      await reviewed.bulkTrashFromSenders(
        ["news@example.com"],
        "me@example.com",
        "account-1",
      );

      expect(provider.bulkTrashFromSenders).not.toHaveBeenCalled();
      expect(provider.archiveMessages).toHaveBeenCalledWith(
        ["m1", "m2"],
        "Label_review",
      );
      expect(provider.archiveMessages).toHaveBeenCalledWith(
        ["m3"],
        "Label_review",
      );
    });

    it("passes other methods through", async () => {
      await reviewed.archiveThread("thread-1", "me@example.com");
      expect(provider.archiveThread).toHaveBeenCalledWith(
        "thread-1",
        "me@example.com",
      );
    });
  });

  describe("folder providers", () => {
    it("sends moves into the trash or junk folder to review", async () => {
      const provider = createMockEmailProvider({
        name: "imap",
        getOrCreateFolderIdByName: vi.fn().mockResolvedValue("Review"),
        moveMessagesToFolder: vi.fn(),
        moveThreadFromFolderToInbox: vi.fn(),
        getFolders: vi.fn().mockResolvedValue([
          {
            id: "Trash",
            displayName: "Trash",
            systemType: "TRASH",
            childFolders: [],
          },
          {
            id: "INBOX",
            displayName: "INBOX",
            systemType: "INBOX",
            childFolders: [
              {
                id: "INBOX.Junk",
                displayName: "Junk",
                systemType: "SPAM",
                childFolders: [],
              },
            ],
          },
          { id: "Projects", displayName: "Projects", childFolders: [] },
        ]),
      });
      const reviewed = withReviewBeforeDelete(provider, "Review", logger);

      await reviewed.moveThreadToFolder("t1", "me@example.com", "trash");
      await reviewed.moveThreadToFolder("t2", "me@example.com", "INBOX.Junk");
      await reviewed.moveThreadToFolder("t3", "me@example.com", "Projects");
      await reviewed.moveMessagesToFolder?.(["m1"], "Junk");

      expect(vi.mocked(provider.moveThreadToFolder).mock.calls).toEqual([
        ["t1", "me@example.com", "Review"],
        ["t2", "me@example.com", "Review"],
        ["t3", "me@example.com", "Projects"],
      ]);
      expect(provider.moveMessagesToFolder).toHaveBeenCalledWith(
        ["m1"],
        "Review",
      );
    });

    it("moves every message of a sender when pages are offsets", async () => {
      let inbox = Array.from({ length: 250 }, (_, index) => `m${index}`);
      const provider = createMockEmailProvider({
        name: "imap",
        getOrCreateFolderIdByName: vi.fn().mockResolvedValue("Review"),
        moveThreadFromFolderToInbox: vi.fn(),
        getMessagesFromSender: vi.fn(async ({ maxResults, pageToken }) => {
          const offset = Number(pageToken ?? 0);
          const end = offset + (maxResults ?? 20);
          return {
            messages: inbox.slice(offset, end).map((id) => ({ id })),
            nextPageToken: end < inbox.length ? String(end) : undefined,
          };
        }) as never,
        moveMessagesToFolder: vi.fn(async (messageIds: string[]) => {
          inbox = inbox.filter((id) => !messageIds.includes(id));
        }),
      });
      const reviewed = withReviewBeforeDelete(provider, "Review", logger);

      await reviewed.bulkTrashFromSenders(["news@example.com"], "me", "a");

      expect(inbox).toEqual([]);
    });

    it("moves to the review folder and restores only from it", async () => {
      const provider = createMockEmailProvider({
        name: "imap",
        getOrCreateFolderIdByName: vi.fn().mockResolvedValue("Review"),
        moveMessagesToFolder: vi.fn(),
        moveThreadFromFolderToInbox: vi.fn(),
      });
      const reviewed = withReviewBeforeDelete(provider, "Review", logger);

      await reviewed.trashThread("thread-1", "me@example.com", "user");
      await reviewed.markSpam("thread-2");
      await reviewed.trashMessages(["m1"]);
      await reviewed.untrashThread("thread-1");

      expect(provider.trashThread).not.toHaveBeenCalled();
      expect(provider.markSpam).not.toHaveBeenCalled();
      expect(provider.moveThreadToFolder).toHaveBeenCalledWith(
        "thread-1",
        "me@example.com",
        "Review",
      );
      expect(provider.moveThreadToFolder).toHaveBeenCalledWith(
        "thread-2",
        "",
        "Review",
      );
      expect(provider.moveMessagesToFolder).toHaveBeenCalledWith(
        ["m1"],
        "Review",
      );
      expect(provider.moveThreadFromFolderToInbox).toHaveBeenCalledWith(
        "thread-1",
        "Review",
      );
      expect(provider.getOrCreateFolderIdByName).toHaveBeenCalledTimes(1);
    });

    it("refuses a provider that cannot move to folders", () => {
      const provider = createMockEmailProvider({ name: "microsoft" });
      expect(() => withReviewBeforeDelete(provider, "Review", logger)).toThrow(
        /not supported/,
      );
    });
  });
});
