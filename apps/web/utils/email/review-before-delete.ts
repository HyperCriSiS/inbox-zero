import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";

// Gmail's system labels. A label action that names one of them would trash or
// spam a thread without going through trashThread or markSpam.
const RESERVED_LABEL_IDS = new Set(["TRASH", "SPAM"]);
const MAX_SENDER_PAGES = 200;
const SENDER_PAGE_SIZE = 100;

type ReviewTarget = {
  moveThread(threadId: string, ownerEmail: string): Promise<void>;
  moveMessages(messageIds: string[]): Promise<void>;
  restoreThread(threadId: string): Promise<void>;
  restoreMessages(messageIds: string[]): Promise<void>;
  /** Gmail only: the review label id that replaces TRASH and SPAM. */
  reservedLabelReplacement?: () => Promise<string>;
  /** Folder providers: the folder to use instead of a trash or junk folder. */
  folderReplacement?: (folder: string) => Promise<string>;
};

/**
 * With REVIEW_BEFORE_DELETE_LABEL set, nothing reaches Trash or Spam. Every
 * trash and spam operation moves the mail to that label (Gmail) or folder
 * (Outlook, IMAP) instead, and the user empties it after checking it. Rules,
 * the chat, bulk actions and the mail UI all go through these provider methods.
 */
export function withReviewBeforeDelete(
  provider: EmailProvider,
  reviewName: string | undefined,
  logger: Logger,
): EmailProvider {
  const name = reviewName?.trim();
  if (!name) return provider;

  const target =
    provider.name === "google"
      ? labelTarget(provider, name)
      : folderTarget(provider, name);

  const replaceReserved = async (labelId: string) =>
    target.reservedLabelReplacement && RESERVED_LABEL_IDS.has(labelId)
      ? target.reservedLabelReplacement()
      : labelId;

  const replaceFolder = (folder: string) =>
    target.folderReplacement ? target.folderReplacement(folder) : folder;

  const overrides: Partial<EmailProvider> = {
    // A rule or the chat moving mail to the trash or junk folder by name
    // would otherwise skip review.
    async moveThreadToFolder(threadId, ownerEmail, folder) {
      await provider.moveThreadToFolder(
        threadId,
        ownerEmail,
        await replaceFolder(folder),
      );
    },

    async trashThread(threadId, ownerEmail) {
      logger.info("Moving thread to review instead of trash", { threadId });
      await target.moveThread(threadId, ownerEmail);
    },

    async trashMessages(messageIds) {
      await target.moveMessages(messageIds);
    },

    async markSpam(threadId) {
      logger.info("Moving thread to review instead of spam", { threadId });
      await target.moveThread(threadId, "");
    },

    async untrashThread(threadId) {
      await target.restoreThread(threadId);
    },

    async untrashMessages(messageIds) {
      await target.restoreMessages(messageIds);
    },

    async bulkTrashFromSenders(fromEmails) {
      for (const senderEmail of fromEmails) {
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_SENDER_PAGES; page++) {
          const result = await provider.getMessagesFromSender({
            senderEmail,
            maxResults: SENDER_PAGE_SIZE,
            pageToken,
          });
          const messageIds = result.messages.map((message) => message.id);
          if (messageIds.length) await target.moveMessages(messageIds);
          pageToken = result.nextPageToken;
          if (!pageToken) break;
        }
      }
    },

    async labelMessage(options) {
      return provider.labelMessage({
        ...options,
        labelId: await replaceReserved(options.labelId),
      });
    },

    async archiveThreadWithLabel(threadId, ownerEmail, labelId) {
      await provider.archiveThreadWithLabel(
        threadId,
        ownerEmail,
        labelId ? await replaceReserved(labelId) : labelId,
      );
    },

    async archiveMessages(messageIds, labelId) {
      await provider.archiveMessages(
        messageIds,
        labelId ? await replaceReserved(labelId) : labelId,
      );
    },

    async createFilter(options) {
      return provider.createFilter({
        ...options,
        addLabelIds: options.addLabelIds
          ? await Promise.all(options.addLabelIds.map(replaceReserved))
          : options.addLabelIds,
      });
    },
  };

  const { moveMessagesToFolder } = provider;
  if (moveMessagesToFolder) {
    overrides.moveMessagesToFolder = async (messageIds, folder) =>
      moveMessagesToFolder.call(
        provider,
        messageIds,
        await replaceFolder(folder),
      );
  }

  return new Proxy(provider, {
    get(target, property, receiver) {
      if (Object.hasOwn(overrides, property)) {
        return overrides[property as keyof EmailProvider];
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function labelTarget(provider: EmailProvider, name: string): ReviewTarget {
  const getLabelId = memoize(async () => {
    const label =
      (await provider.getLabelByName(name)) ??
      (await provider.createLabel(
        name,
        "Mail Inbox Zero would have deleted or marked as spam",
      ));
    return label.id;
  });

  return {
    async moveThread(threadId, ownerEmail) {
      await provider.archiveThreadWithLabel(
        threadId,
        ownerEmail,
        await getLabelId(),
      );
    },
    async moveMessages(messageIds) {
      await provider.archiveMessages(messageIds, await getLabelId());
    },
    async restoreThread(threadId) {
      await provider.removeThreadLabel(threadId, await getLabelId());
      await provider.unarchiveThread(threadId);
    },
    async restoreMessages(messageIds) {
      await provider.unarchiveMessages(messageIds);
    },
    reservedLabelReplacement: getLabelId,
  };
}

function folderTarget(provider: EmailProvider, name: string): ReviewTarget {
  const { moveMessagesToFolder, moveThreadFromFolderToInbox } = provider;
  if (!moveMessagesToFolder || !moveThreadFromFolderToInbox) {
    throw new Error(
      `REVIEW_BEFORE_DELETE_LABEL is not supported for ${provider.name}`,
    );
  }
  const getFolderId = memoize(() => provider.getOrCreateFolderIdByName(name));
  const getDeleteFolders = memoize(async () => {
    const names = new Set<string>();
    const visit = (
      folders: Awaited<ReturnType<EmailProvider["getFolders"]>>,
    ) => {
      for (const folder of folders) {
        if (folder.systemType === "TRASH" || folder.systemType === "SPAM") {
          names.add(folder.id.toLowerCase());
          names.add(folder.displayName.toLowerCase());
        }
        visit(folder.childFolders ?? []);
      }
    };
    visit(await provider.getFolders());
    // Outlook also accepts its well-known names in place of ids.
    names.add("deleteditems");
    names.add("junkemail");
    return names;
  });

  return {
    async folderReplacement(folder) {
      const deleteFolders = await getDeleteFolders();
      return deleteFolders.has(folder.toLowerCase()) ? getFolderId() : folder;
    },
    async moveThread(threadId, ownerEmail) {
      await provider.moveThreadToFolder(
        threadId,
        ownerEmail,
        await getFolderId(),
      );
    },
    async moveMessages(messageIds) {
      await moveMessagesToFolder.call(
        provider,
        messageIds,
        await getFolderId(),
      );
    },
    async restoreThread(threadId) {
      await moveThreadFromFolderToInbox.call(
        provider,
        threadId,
        await getFolderId(),
      );
    },
    async restoreMessages(messageIds) {
      await provider.unarchiveMessages(messageIds);
    },
  };
}

// Caches a successful lookup and retries a failed one on the next call.
function memoize<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    cached ??= load().catch((error) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
}
