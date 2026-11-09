import { Readable } from "node:stream";
import type { ImapFlow, SearchObject } from "imapflow";
import { type AddressObject, type ParsedMail, simpleParser } from "mailparser";
import type Mail from "nodemailer/lib/mailer";
import type { LocalMailSyncRequest } from "@/utils/actions/local-mail-sync.validation";
import type { DraftAttachmentMetadata } from "@/utils/actions/draft-attachments.validation";
import type {
  BulkArchiveResult,
  BulkArchiveThread,
  DraftAttachmentsResult,
  DraftAttachmentUploadStart,
  EmailFilter,
  EmailFolderCount,
  EmailLabel,
  EmailLabelColor,
  EmailLabelUpdate,
  EmailProvider,
  EmailSignature,
  EmailThread,
  GetThreadOptions,
  MailboxSyncPage,
  ProviderMailboxSearch,
  SendEmailOptions,
} from "@/utils/email/types";

import { getGmailDefaultLabelColor, type LabelColorName } from "@/utils/label";
import type { LocalMailSyncResponse } from "@/utils/email/local-mail-sync-types";
import {
  type EmailContact,
  normalizeContactCandidates,
} from "@/utils/email/contact";
import { searchImapContacts } from "@/utils/imap/contacts";
import type { SendAsAddress } from "@/utils/email/send-as";
import { extractEmailAddress } from "@/utils/email";
import { DraftNotFoundError } from "@/utils/error";
import { InvalidMailboxSyncCursorError } from "@/utils/email/mailbox-sync";
import {
  type ImapAccount,
  isAuthenticationFailure,
  markImapDisconnected,
} from "@/utils/imap/config";
import { withImapClient } from "@/utils/imap/connection";
import {
  isLabelFolder,
  toLabelFolderName,
  keywordToLabel,
  labelToKeyword,
} from "@/utils/imap/labels";
import {
  getMessageLabelIds,
  type ImapMailboxRole,
  toParsedMessage,
} from "@/utils/imap/message";
import {
  composeMessage,
  parseRecipients,
  sendRawMessage,
} from "@/utils/imap/smtp";
import { ensureIndexed } from "@/utils/imap/index-messages";
import { parseMessageIds, resolveThread } from "@/utils/imap/thread";
import {
  matchesThreadFilter,
  parseThreadQuery,
  type ThreadScope,
} from "@/utils/imap/thread-query";
import { inboxZeroLabels, type InboxZeroLabel } from "@/utils/label";
import type { Logger } from "@/utils/logger";
import { convertEmailHtmlToText } from "@/utils/mail";
import type {
  OutlookFolder,
  OutlookSystemFolder,
} from "@/utils/outlook/folders";
import prisma from "@/utils/prisma";
import type { ThreadsQuery } from "@/utils/threads/validation";
import type { ParsedMessage } from "@/utils/types";
import type { SendEmailBody } from "@/utils/types/mail";

const DEFAULT_PAGE_SIZE = 20;
const UID_CHUNK = 500;

export class UnsupportedImapOperationError extends Error {
  constructor(operation: string) {
    super(`${operation} is not supported for IMAP accounts`);
    this.name = "UnsupportedImapOperationError";
  }
}

type MessageRow = {
  id: string;
  labels: string[];
  mailbox: {
    id: string;
    path: string;
    role: string | null;
    uidValidity: bigint;
  };
  mailboxId: string;
  rfc822MessageId: string | null;
  threadId: string;
  uid: bigint;
  uidValidity: bigint;
};

const messageRowInclude = {
  mailbox: {
    select: { id: true, path: true, role: true, uidValidity: true },
  },
} as const;

export class ImapProvider implements EmailProvider {
  readonly name = "imap";
  readonly localMailSyncStrategy = "account-history";
  private readonly account: ImapAccount;
  private readonly logger: Logger;

  constructor(account: ImapAccount, logger: Logger) {
    this.account = account;
    this.logger = logger;
  }

  toJSON() {
    return { name: this.name, type: "imap" };
  }

  getAccessToken() {
    return "";
  }

  // --- Reading ---

  async getMessage(messageId: string): Promise<ParsedMessage> {
    const [message] = await this.getMessagesBatch([messageId]);
    if (!message) throw notFoundError();
    return message;
  }

  async getMessagesBatch(messageIds: string[]): Promise<ParsedMessage[]> {
    const rows = await this.findRows({ id: { in: messageIds } });
    return this.readRows(rows);
  }

  async getMessageByRfc822MessageId(
    rfc822MessageId: string,
  ): Promise<ParsedMessage | null> {
    const id = parseMessageIds(rfc822MessageId)[0];
    if (!id) return null;
    const rows = await this.findRows({ rfc822MessageId: id });
    const [message] = await this.readRows(rows.slice(0, 1));
    return message ?? null;
  }

  async getOriginalMessage(
    originalMessageId: string | undefined,
  ): Promise<ParsedMessage | null> {
    if (!originalMessageId) return null;
    return this.getMessageByRfc822MessageId(originalMessageId);
  }

  async getMessageSource(messageId: string): Promise<Buffer> {
    const [row] = await this.findRows({ id: messageId });
    if (!row) throw new Error("Message not found");
    return this.withClient((client) => readSource(client, row));
  }

  async getInboxMessages(maxResults = DEFAULT_PAGE_SIZE) {
    const { messages } = await this.getMessagesWithPagination({ maxResults });
    return messages;
  }

  async getInboxStats() {
    const mailbox = await this.requireMailbox("inbox");
    return this.withClient(async (client) => {
      const status = await client.status(mailbox.path, {
        messages: true,
        unseen: true,
      });
      if (!status) throw new Error("Could not read inbox status");
      return { total: status.messages ?? 0, unread: status.unseen ?? 0 };
    });
  }

  async getMessagesWithPagination(options: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
    folderId?: string;
    before?: Date;
    after?: Date;
    inboxOnly?: boolean;
    unreadOnly?: boolean;
    includeDrafts?: boolean;
  }) {
    // The local client has one stream per account, so it bootstraps everything.
    if (options.includeDrafts && !options.folderId) {
      return this.listAllMessages(options);
    }

    const mailbox = options.folderId
      ? await this.requireMailboxByPath(options.folderId)
      : await this.requireMailbox("inbox");

    const { rows, nextPageToken } = await this.searchMailbox({
      mailbox,
      criteria: {
        ...parseImapQuery(options.query),
        ...(options.before && { before: options.before }),
        ...(options.after && { since: options.after }),
        ...(options.unreadOnly && { seen: false }),
      },
      maxResults: options.maxResults,
      pageToken: options.pageToken,
    });

    return { messages: await this.readRows(rows), nextPageToken };
  }

  async getMessagesFromSender(options: {
    senderEmail: string;
    maxResults?: number;
    pageToken?: string;
    before?: Date;
    after?: Date;
  }) {
    const { rows, nextPageToken } = await this.searchMailbox({
      mailbox: await this.requireMailbox("inbox"),
      criteria: {
        ...(options.before && { before: options.before }),
        ...(options.after && { since: options.after }),
      },
      sender: options.senderEmail,
      maxResults: options.maxResults,
      pageToken: options.pageToken,
    });
    return { messages: await this.readRows(rows), nextPageToken };
  }

  async getMessagesWithAttachments(options: {
    maxResults?: number;
    pageToken?: string;
  }) {
    const { messages, nextPageToken } = await this.getMessagesWithPagination({
      ...options,
      query: "has:attachment",
    });
    return {
      messages: messages.filter((message) => message.hasAttachment),
      nextPageToken,
    };
  }

  async searchMessages(options: {
    query: string;
    maxResults?: number;
    pageToken?: string;
    fromEmail?: string;
    readState?: "read" | "unread";
    labelName?: string;
    folderId?: string;
    labelIds?: string[];
    includeSpamTrash?: boolean;
    folder?: "spam" | "trash";
    mailboxSearch?: ProviderMailboxSearch;
  }) {
    const mailbox = await this.resolveSearchMailbox(options);
    const { rows, nextPageToken } = await this.searchMailbox({
      mailbox,
      criteria: {
        ...parseImapQuery(options.query),
        ...(options.fromEmail && { from: options.fromEmail }),
        ...(options.readState && { seen: options.readState === "read" }),
        ...(options.labelName && this.labelCriteria(options.labelName)),
        ...mailboxSearchCriteria(options.mailboxSearch),
      },
      maxResults: options.maxResults,
      pageToken: options.pageToken,
    });

    const messages = await this.readRows(rows);
    if (!options.labelName) return { messages, nextPageToken };

    const label = await this.getLabelByName(options.labelName);
    return {
      messages: messages.filter((message) =>
        message.labelIds?.includes(label?.id ?? options.labelName ?? ""),
      ),
      nextPageToken,
    };
  }

  async searchThreads(options: {
    query: string;
    maxResults?: number;
    pageToken?: string;
    messageFormat?: "full" | "metadata";
    includeSpamTrash?: boolean;
    folder?: "spam" | "trash";
    labelIds?: string[];
  }) {
    const { messages, nextPageToken } = await this.searchMessages(options);
    return { threads: await this.toThreads(messages), nextPageToken };
  }

  // --- Threads ---

  async getThread(
    threadId: string,
    options?: GetThreadOptions,
  ): Promise<EmailThread> {
    const messages = await this.readThread(threadId, options?.includeDrafts);
    if (!messages.length) throw new Error("Thread not found");
    return toThread(threadId, messages);
  }

  async getThreadMessages(threadId: string) {
    return this.readThread(threadId, false);
  }

  async getThreadMessagesInInbox(threadId: string) {
    const rows = await this.findThreadRows(threadId);
    return sortChronologically(
      await this.readRows(rows.filter((row) => row.mailbox.role === "inbox")),
    );
  }

  async getThreads(folderId?: string) {
    const { messages } = await this.getMessagesWithPagination({ folderId });
    return this.toThreads(messages);
  }

  async getThreadsWithQuery(options: {
    query?: ThreadsQuery;
    maxResults?: number;
    pageToken?: string;
    messageFormat?: "full" | "metadata";
    skipParticipantMessages?: boolean;
  }) {
    const query = options.query;
    if (query?.q) {
      return this.searchThreads({
        query: query.q,
        maxResults: options.maxResults,
        pageToken: options.pageToken,
      });
    }

    const scope = parseThreadQuery(query);
    const { rows, nextPageToken } = await this.findThreadQueryRows(
      query,
      scope,
      { maxResults: options.maxResults, pageToken: options.pageToken },
    );
    const excludedLabels = await this.resolveLabelIds(query?.excludeLabelNames);
    const messages = (await this.readRows(rows)).filter((message) =>
      matchesThreadFilter(message, {
        after: query?.after,
        before: query?.before,
        excludedLabels,
        fromEmail: query?.fromEmail,
        labels: scope.labels,
        unread: scope.unread,
      }),
    );

    return { threads: await this.toThreads(messages), nextPageToken };
  }

  async getThreadsWithLabel(options: { labelId: string; maxResults?: number }) {
    const { threads } = await this.getThreadsWithQuery({
      query: { labelId: options.labelId } as ThreadsQuery,
      maxResults: options.maxResults,
    });
    return threads;
  }

  async getThreadsWithParticipant(options: {
    participantEmail: string;
    maxThreads?: number;
  }) {
    const { messages } = await this.getMessagesFromSender({
      senderEmail: options.participantEmail,
      maxResults: options.maxThreads,
    });
    return this.toThreads(messages);
  }

  async getThreadsFromSenderWithSubject(sender: string, limit: number) {
    const { messages } = await this.getMessagesFromSender({
      senderEmail: sender,
      maxResults: limit,
    });
    const threads = await this.toThreads(messages);
    return threads.map((thread) => ({
      id: thread.id,
      snippet: thread.snippet,
      subject: thread.messages[0]?.subject ?? "",
    }));
  }

  async getLatestMessageInThread(threadId: string) {
    return this.readThread(threadId, false).then((list) => list.at(-1) ?? null);
  }

  async getLatestMessageFromThreadSnapshot(
    thread: Pick<EmailThread, "id" | "messages">,
  ) {
    return thread.messages.at(-1) ?? this.getLatestMessageInThread(thread.id);
  }

  async getPreviousConversationMessages(messageIds: string[]) {
    return sortChronologically(await this.getMessagesBatch(messageIds));
  }

  // --- Sent ---

  async getSentMessages(maxResults = DEFAULT_PAGE_SIZE) {
    const mailbox = await this.requireMailbox("sent");
    const { rows } = await this.searchMailbox({
      mailbox,
      criteria: {},
      maxResults,
    });
    return this.readRows(rows);
  }

  async getSentMessageIds(options: {
    maxResults: number;
    after?: Date;
    before?: Date;
    pageToken?: string;
  }) {
    const mailbox = await this.requireMailbox("sent");
    const { rows, nextPageToken } = await this.searchMailbox({
      mailbox,
      criteria: {
        ...(options.after && { since: options.after }),
        ...(options.before && { before: options.before }),
      },
      maxResults: options.maxResults,
      pageToken: options.pageToken,
    });
    return {
      messages: rows.map(({ id, threadId }) => ({ id, threadId })),
      nextPageToken,
    };
  }

  async getSentThreadsExcluding(options: {
    excludeToEmails?: string[];
    excludeFromEmails?: string[];
    maxResults?: number;
  }) {
    const excludedTo = new Set(options.excludeToEmails?.map(normalizeAddress));
    const excludedFrom = new Set(
      options.excludeFromEmails?.map(normalizeAddress),
    );
    const messages = await this.getSentMessages(options.maxResults);

    return this.toThreads(
      messages.filter(
        (message) =>
          !excludedTo.has(normalizeAddress(message.headers.to)) &&
          !excludedFrom.has(normalizeAddress(message.headers.from)),
      ),
    );
  }

  async checkIfReplySent(senderEmail: string) {
    return (await this.countInRole("sent", "to", senderEmail, 1)) > 0;
  }

  async countReceivedMessages(senderEmail: string, threshold: number) {
    return this.countInRole("inbox", "from", senderEmail, threshold);
  }

  async hasPreviousCommunicationsWithSenderOrDomain(options: {
    from: string;
    date: Date;
    messageId: string;
  }) {
    const address = extractEmailAddress(options.from);
    const before = { before: options.date };
    const sent = await this.countInRole("sent", "to", address, 1, before);
    if (sent > 0) return true;
    return (await this.countInRole("inbox", "from", address, 1, before)) > 0;
  }

  async countMessages(options: { folderId?: string; labelId?: string }) {
    const { labelId, folderId } = options;
    const { connectionId, labelStrategy } = this.account;
    if (labelId && labelStrategy === "database") {
      return prisma.imapMessage.count({
        where: { connectionId, labels: { has: labelId } },
      });
    }

    const folderPath =
      folderId ?? (labelStrategy === "folders" ? labelId : undefined);
    const mailbox = folderPath
      ? await this.requireMailboxByPath(folderPath)
      : await this.requireMailbox("inbox");
    return this.withClient(async (client) => {
      const uids = await searchUids(client, mailbox.path, {
        ...(labelId && this.labelCriteria(labelId)),
      });
      return uids.length;
    });
  }

  isSentMessage(message: ParsedMessage) {
    // The location is the proof. A From header can be forged by any sender.
    return !!message.labelIds?.includes("SENT");
  }

  isReplyInThread(message: ParsedMessage) {
    return !!(message.headers["in-reply-to"] || message.headers.references);
  }

  // --- Actions ---

  async archiveThread(threadId: string, _ownerEmail: string) {
    await this.moveToRole(await this.findThreadRows(threadId), "archive");
  }

  async archiveThreadWithLabel(
    threadId: string,
    ownerEmail: string,
    labelId?: string,
  ) {
    if (labelId) await this.applyLabel(threadId, labelId);
    await this.archiveThread(threadId, ownerEmail);
  }

  async archiveMessage(messageId: string) {
    await this.archiveMessages([messageId]);
  }

  async archiveMessages(messageIds: string[], labelId?: string) {
    const rows = await this.findRows({ id: { in: messageIds } });
    if (labelId) await this.labelRows(rows, labelId);
    await this.moveToRole(rows, "archive");
  }

  async unarchiveThread(threadId: string) {
    await this.moveToRole(await this.findThreadRows(threadId), "inbox");
  }

  async unarchiveMessages(messageIds: string[]) {
    await this.moveToRole(
      await this.findRows({ id: { in: messageIds } }),
      "inbox",
    );
  }

  async trashThread(
    threadId: string,
    _ownerEmail: string,
    _actionSource: "user" | "automation",
  ) {
    await this.moveToRole(await this.findThreadRows(threadId), "trash");
  }

  async trashMessages(messageIds: string[]) {
    await this.moveToRole(
      await this.findRows({ id: { in: messageIds } }),
      "trash",
    );
  }

  async untrashThread(threadId: string) {
    await this.unarchiveThread(threadId);
  }

  async untrashMessages(messageIds: string[]) {
    await this.unarchiveMessages(messageIds);
  }

  async markSpam(threadId: string) {
    await this.moveToRole(await this.findThreadRows(threadId), "junk");
  }

  async markNotSpam(threadId: string) {
    await this.unarchiveThread(threadId);
  }

  async blockUnsubscribedEmail(messageId: string) {
    await this.archiveMessage(messageId);
  }

  async moveThreadToFolder(
    threadId: string,
    _ownerEmail: string,
    folderName: string,
  ) {
    const path = await this.getOrCreateFolderIdByName(folderName);
    await this.moveRows(await this.findThreadRows(threadId), path);
  }

  async moveMessagesToFolder(messageIds: string[], folderId: string) {
    await this.moveRows(
      await this.findRows({ id: { in: messageIds } }),
      folderId,
    );
  }

  async moveThreadFromFolderToInbox(threadId: string, folderId: string) {
    const rows = await this.findThreadRows(threadId);
    await this.moveToRole(
      rows.filter((row) => row.mailbox.path === folderId),
      "inbox",
    );
  }

  async markRead(threadId: string) {
    await this.markReadThread(threadId, true);
  }

  async markReadThread(threadId: string, read: boolean) {
    await this.setFlag(await this.findThreadRows(threadId), "\\Seen", read);
  }

  async markMessagesReadState(messageIds: string[], read: boolean) {
    const rows = await this.findRows({ id: { in: messageIds } });
    await this.setFlag(rows, "\\Seen", read);
  }

  async markMessagesStarredState(messageIds: string[], starred: boolean) {
    const rows = await this.findRows({ id: { in: messageIds } });
    await this.setFlag(rows, "\\Flagged", starred);
  }

  async starMessage(messageId: string) {
    await this.markMessagesStarredState([messageId], true);
  }

  async bulkArchiveFromSenders(
    fromEmails: string[],
    ownerEmail: string,
    emailAccountId: string,
  ) {
    let archived = 0;
    for (const email of fromEmails) {
      archived += await this.bulkArchiveSenderOrThrow(
        email,
        ownerEmail,
        emailAccountId,
      );
    }
    return archived;
  }

  async bulkArchiveSenderOrThrow(
    fromEmail: string,
    _ownerEmail: string,
    _emailAccountId: string,
  ) {
    return this.moveFromSender(fromEmail, "archive");
  }

  async bulkTrashFromSenders(
    fromEmails: string[],
    _ownerEmail: string,
    _emailAccountId: string,
  ) {
    for (const email of fromEmails) await this.moveFromSender(email, "trash");
  }

  async bulkArchiveThreads(
    threads: BulkArchiveThread[],
    ownerEmail: string,
  ): Promise<BulkArchiveResult> {
    const result: BulkArchiveResult = {
      succeededThreadIds: [],
      failedThreadIds: [],
    };
    for (const { threadId } of threads) {
      try {
        await this.archiveThread(threadId, ownerEmail);
        result.succeededThreadIds.push(threadId);
      } catch (error) {
        this.logger.warn("Failed to archive IMAP thread", { threadId, error });
        result.failedThreadIds.push(threadId);
      }
    }
    return result;
  }

  // --- Labels ---

  async getLabels(_options?: {
    includeHidden?: boolean;
  }): Promise<EmailLabel[]> {
    const { labelStrategy, connectionId } = this.account;

    if (labelStrategy === "folders") {
      const mailboxes = await prisma.imapMailbox.findMany({
        where: { connectionId },
        select: { path: true },
      });
      return mailboxes
        .filter(({ path }) => isLabelFolder(path))
        .map(({ path }) => toLabel(path, path.slice("Labels/".length)));
    }

    const connection = await prisma.imapConnection.findUniqueOrThrow({
      where: { id: connectionId },
      select: { labels: true },
    });
    return connection.labels.map((name) => toLabel(name, name));
  }

  async getLabelById(labelId: string) {
    const labels = await this.getLabels();
    return labels.find((label) => label.id === labelId) ?? null;
  }

  async getLabelByName(name: string) {
    const wanted = this.toComparableLabel(name);
    const labels = await this.getLabels();
    return labels.find((label) => label.name.toLowerCase() === wanted) ?? null;
  }

  async createLabel(name: string, _description?: string): Promise<EmailLabel> {
    if (this.account.labelStrategy === "folders") {
      const folderName = toLabelFolderName(name);
      const path = `Labels/${folderName}`;
      return this.withClient(async (client) => {
        // The index only learns of a new folder on the next sync.
        const folders = await client.list();
        const existing = folders.find(
          (folder) => folder.path.toLowerCase() === path.toLowerCase(),
        );
        if (existing) return toLabel(existing.path, existing.name);
        await client.mailboxCreate(path);
        return toLabel(path, folderName);
      });
    }

    const label = await this.getLabelByName(name);
    if (label) return label;
    await prisma.imapConnection.update({
      where: { id: this.account.connectionId },
      data: { labels: { push: name } },
    });
    return toLabel(name, name);
  }

  async getOrCreateInboxZeroLabel(key: InboxZeroLabel) {
    const { name } = inboxZeroLabels[key];
    return (await this.getLabelByName(name)) ?? this.createLabel(name);
  }

  async deleteLabel(labelId: string) {
    if (this.account.labelStrategy === "folders") {
      await this.withClient((client) => client.mailboxDelete(labelId));
      return;
    }

    const connection = await prisma.imapConnection.findUniqueOrThrow({
      where: { id: this.account.connectionId },
      select: { labels: true },
    });
    await prisma.imapConnection.update({
      where: { id: this.account.connectionId },
      data: { labels: connection.labels.filter((name) => name !== labelId) },
    });
  }

  async updateLabel(labelId: string, update: EmailLabelUpdate) {
    if (!update.name || update.name === labelId) return;
    if (this.account.labelStrategy !== "folders") {
      throw new UnsupportedImapOperationError("Renaming a label");
    }
    await this.withClient((client) =>
      client.mailboxRename(
        labelId,
        `Labels/${toLabelFolderName(update.name as string)}`,
      ),
    );
  }

  async labelMessage(options: {
    messageId: string;
    labelId: string;
    labelName: string | null;
  }) {
    const rows = await this.findRows({ id: options.messageId });
    await this.labelRows(rows, options.labelId);
    return { actualLabelId: options.labelId };
  }

  async removeThreadLabel(threadId: string, labelId: string) {
    await this.unlabelRows(await this.findThreadRows(threadId), labelId);
  }

  async removeThreadLabels(threadId: string, labelIds: string[]) {
    const rows = await this.findThreadRows(threadId);
    for (const labelId of labelIds) await this.unlabelRows(rows, labelId);
  }

  // --- Folders ---

  async getFolders(): Promise<OutlookFolder[]> {
    const mailboxes = await prisma.imapMailbox.findMany({
      where: { connectionId: this.account.connectionId },
      select: { path: true, role: true },
    });
    return mailboxes
      .filter(({ path }) => !isLabelFolder(path))
      .map(({ path, role }) => ({
        id: path,
        displayName: path.split(/[/.]/).at(-1) ?? path,
        systemType: role ? ROLE_SYSTEM_FOLDERS[role] : undefined,
        childFolders: [],
        childFolderCount: 0,
        unreadItemCount: 0,
        totalItemCount: 0,
      }));
  }

  async getFolderCounts(): Promise<EmailFolderCount[]> {
    const mailboxes = await prisma.imapMailbox.findMany({
      where: { connectionId: this.account.connectionId },
      select: { path: true, role: true },
    });
    return this.withClient(async (client) => {
      const counts: EmailFolderCount[] = [];
      for (const { path, role } of mailboxes) {
        const status = await client.status(path, {
          messages: true,
          unseen: true,
        });
        if (!status) continue;
        counts.push({
          id: path,
          name: path,
          total: status.messages ?? 0,
          unread: status.unseen ?? 0,
          systemType: role ? ROLE_SYSTEM_FOLDERS[role] : undefined,
        });
      }
      return counts;
    });
  }

  async getOrCreateFolderIdByName(folderName: string) {
    return this.withClient(async (client) => {
      const folders = await client.list();
      const wanted = folderName.toLowerCase();
      const existing = folders.find(
        (folder) =>
          folder.path.toLowerCase() === wanted ||
          folder.name.toLowerCase() === wanted,
      );
      if (existing) return existing.path;
      // Proton Mail Bridge refuses custom folders outside its `Folders` root.
      const created = await client.mailboxCreate(
        this.account.labelStrategy === "folders"
          ? `Folders/${folderName}`
          : folderName,
      );
      return created.path;
    });
  }

  async renameFolder(folderId: string, name: string) {
    await this.withClient(async (client) => {
      const folders = await client.list();
      const folder = folders.find((item) => item.path === folderId);
      await client.mailboxRename(
        folderId,
        folder?.parentPath
          ? `${folder.parentPath}${folder.delimiter}${name}`
          : name,
      );
    });
  }

  async deleteFolder(folderId: string) {
    await this.withClient((client) => client.mailboxDelete(folderId));
  }

  // --- Sending ---

  async sendEmail(args: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageText: string;
    attachments?: Mail.Attachment[];
  }) {
    return this.deliver({
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      text: args.messageText,
      attachments: args.attachments,
    });
  }

  async sendEmailWithHtml(body: SendEmailBody, _options?: SendEmailOptions) {
    const reply = body.replyToEmail;
    const { messageId } = await this.deliver({
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      replyTo: body.replyTo,
      subject: body.subject,
      html: body.messageHtml,
      text: convertEmailHtmlToText({ htmlText: body.messageHtml }),
      inReplyTo: reply?.headerMessageId,
      references: joinReferences(reply?.references, reply?.headerMessageId),
      attachments: body.attachments?.map(toMailAttachment),
    });

    if (body.providerDraftId) await this.deleteDraft(body.providerDraftId);

    const threadId =
      reply?.threadId ??
      resolveThread({
        messageId,
        references: null,
        inReplyTo: null,
        fallbackKey: messageId,
        knownThreadIds: new Map(),
      }).threadId;

    return { messageId, threadId };
  }

  async replyToEmail(
    email: ParsedMessage,
    content: string,
    options?: {
      replyTo?: string;
      from?: string;
      cc?: string;
      bcc?: string;
      attachments?: Mail.Attachment[];
    },
  ) {
    return this.deliver({
      ...buildReplyHeaders(email),
      replyTo: options?.replyTo,
      cc: options?.cc,
      bcc: options?.bcc,
      html: content,
      text: convertEmailHtmlToText({ htmlText: content }),
      attachments: options?.attachments,
    });
  }

  async forwardEmail(
    email: ParsedMessage,
    args: {
      to: string;
      cc?: string;
      bcc?: string;
      content?: string;
      from?: string;
    },
  ) {
    const html = buildForwardHtml(email, args.content);
    return this.deliver({
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: prefixSubject("Fwd:", email.subject),
      html,
      text: convertEmailHtmlToText({ htmlText: html }),
      attachments: await this.readAttachments(email.id),
    });
  }

  // --- Drafts ---

  async getDrafts(options?: { maxResults?: number }) {
    const mailbox = await this.requireMailbox("drafts");
    const { rows } = await this.searchMailbox({
      mailbox,
      criteria: {},
      maxResults: options?.maxResults,
    });
    return this.readRows(rows);
  }

  async getDraft(
    draftId: string,
    _options?: { includeAttachments?: boolean },
  ): Promise<ParsedMessage | null> {
    const [row] = await this.findRows({ id: draftId });
    if (row?.mailbox.role !== "drafts") return null;
    const [draft] = await this.readRows([row]);
    return draft ?? null;
  }

  async getDraftReferenceForMessage(messageId: string) {
    const [row] = await this.findRows({ id: messageId });
    return row?.mailbox.role === "drafts" ? { id: row.id } : null;
  }

  async createDraft(params: {
    to: string;
    from?: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageHtml: string;
    replyToMessageId?: string;
    forwardedMessageId?: string;
  }) {
    const replyTo = params.replyToMessageId
      ? await this.getMessage(params.replyToMessageId)
      : null;

    return this.storeDraft(
      {
        to: params.to,
        cc: params.cc,
        bcc: params.bcc,
        subject: params.subject,
        html: params.messageHtml,
        ...(replyTo && {
          inReplyTo: replyTo.headers["message-id"],
          references: joinReferences(
            replyTo.headers.references,
            replyTo.headers["message-id"],
          ),
        }),
        attachments: params.forwardedMessageId
          ? await this.readAttachments(params.forwardedMessageId)
          : undefined,
      },
      replyTo?.threadId,
    );
  }

  async draftEmail(
    email: ParsedMessage,
    args: {
      to?: string;
      subject?: string;
      content: string;
      cc?: string;
      bcc?: string;
      attachments?: Mail.Attachment[];
    },
    _userEmail: string,
    _executedRule?: { id: string; threadId: string; emailAccountId: string },
  ) {
    const reply = buildReplyHeaders(email);
    const { id } = await this.storeDraft(
      {
        ...reply,
        to: args.to ?? reply.to,
        subject: args.subject ?? reply.subject,
        cc: args.cc,
        bcc: args.bcc,
        html: args.content,
        attachments: args.attachments,
      },
      email.threadId,
    );
    return { draftId: id };
  }

  async updateDraft(
    draftId: string,
    params: {
      messageHtml?: string;
      subject?: string;
      to?: string;
      from?: string;
      cc?: string;
      bcc?: string;
    },
  ) {
    await this.rewriteDraft(draftId, (mail, attachments) => ({
      to: params.to ?? addressText(mail.to),
      cc: params.cc ?? addressText(mail.cc),
      bcc: params.bcc ?? addressText(mail.bcc),
      subject: params.subject ?? mail.subject,
      html: params.messageHtml ?? (mail.html || undefined),
      attachments,
    }));
  }

  async deleteDraft(draftId: string, _version?: string) {
    const [row] = await this.findRows({ id: draftId });
    if (row?.mailbox.role !== "drafts") return false;

    await this.withClient(async (client) => {
      const lock = await client.getMailboxLock(row.mailbox.path);
      try {
        await client.messageDelete(String(row.uid), { uid: true });
      } finally {
        lock.release();
      }
    });
    await prisma.imapMessage.delete({ where: { id: row.id } });
    await this.recordChanges([row.id], "delete");
    return true;
  }

  async sendDraft(draftId: string) {
    const row = await this.requireDraftRow(draftId);

    const raw = await this.withClient((client) => readSource(client, row));
    const mail = await simpleParser(raw);
    const messageId = mail.messageId ?? "";
    const recipients = [mail.to, mail.cc, mail.bcc]
      .flat()
      .flatMap((list) => list?.value ?? [])
      .flatMap((address) => address.address ?? []);

    await sendRawMessage(
      this.account,
      { from: this.account.email, to: recipients },
      raw,
    );
    await this.storeSentCopy(raw, messageId);
    await this.deleteDraft(draftId);
    return { messageId, threadId: row.threadId };
  }

  async getDraftAttachments(
    draftId: string,
  ): Promise<DraftAttachmentsResult | null> {
    const draft = await this.getDraft(draftId);
    if (!draft) return null;
    return {
      messageId: draft.id,
      attachments: (draft.attachments ?? []).map((attachment) => ({
        id: attachment.attachmentId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        disposition: "attachment",
        messageId: draft.id,
        providerAttachmentId: attachment.attachmentId,
      })),
    };
  }

  async addDraftAttachment(
    draftId: string,
    attachment: DraftAttachmentMetadata & { content: Buffer },
  ): Promise<DraftAttachmentsResult & { attachmentId: string }> {
    const before = new Set(
      (await this.getDraftAttachments(draftId))?.attachments.map(
        (item) => item.id,
      ),
    );
    await this.rewriteDraftAttachments(draftId, (list) => [
      ...list,
      {
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.mimeType,
      },
    ]);
    const result = await this.requireDraftAttachments(draftId);
    const added = result.attachments.find((item) => !before.has(item.id));
    return { ...result, attachmentId: added?.id ?? "" };
  }

  async removeDraftAttachment(draftId: string, attachmentId: string) {
    const current = await this.requireDraftAttachments(draftId);
    const position = current.attachments.findIndex(
      (item) => item.id === attachmentId,
    );
    await this.rewriteDraftAttachments(draftId, (list) =>
      list.filter((_, index) => index !== position),
    );
    return this.requireDraftAttachments(draftId);
  }

  async startDraftAttachmentUpload(
    _draftId: string,
    _attachment: DraftAttachmentMetadata,
  ): Promise<DraftAttachmentUploadStart> {
    throw new UnsupportedImapOperationError("Resumable attachment upload");
  }

  // --- Attachments ---

  async getAttachment(messageId: string, attachmentId: string) {
    const attachment = await this.findAttachment(messageId, attachmentId);
    return {
      data: attachment.content.toString("base64url"),
      size: attachment.size,
    };
  }

  async getAttachmentStream(
    messageId: string,
    attachmentId: string,
    _signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const attachment = await this.findAttachment(messageId, attachmentId);
    return Readable.toWeb(
      Readable.from(attachment.content),
    ) as ReadableStream<Uint8Array>;
  }

  // --- Not available over IMAP ---

  // --- Filters, kept in the database and applied by the sync ---

  async getFiltersList(): Promise<EmailFilter[]> {
    const filters = await prisma.imapFilter.findMany({
      where: { connectionId: this.account.connectionId },
    });
    return filters.map((filter) => ({
      id: filter.id,
      criteria: { from: filter.from },
      action: {
        addLabelIds: filter.addLabelIds,
        removeLabelIds: filter.archive ? ["INBOX"] : [],
      },
    }));
  }

  async createFilter(options: {
    from: string;
    addLabelIds?: string[];
    removeLabelIds?: string[];
  }) {
    await this.saveFilter({
      from: options.from,
      archive: !!options.removeLabelIds?.includes("INBOX"),
      addLabelIds: options.addLabelIds ?? [],
    });
    return { status: 200 };
  }

  async createAutoArchiveFilter(options: {
    from: string;
    gmailLabelId?: string;
    labelName?: string;
  }) {
    const labelId = options.gmailLabelId ?? options.labelName;
    await this.saveFilter({
      from: options.from,
      archive: true,
      addLabelIds: labelId ? [labelId] : [],
    });
    return { status: 200 };
  }

  async deleteFilter(id: string) {
    await prisma.imapFilter.deleteMany({
      where: { id, connectionId: this.account.connectionId },
    });
    return { status: 200 };
  }

  /** Returns true when the message was archived, so rules should not run. */
  async applyFilters(message: ParsedMessage) {
    const from = normalizeAddress(message.headers.from);
    const filter = await prisma.imapFilter.findUnique({
      where: {
        connectionId_from: { connectionId: this.account.connectionId, from },
      },
    });
    if (!filter) return false;

    for (const labelId of filter.addLabelIds) {
      await this.labelMessage({
        messageId: message.id,
        labelId,
        labelName: null,
      });
    }
    if (filter.archive) await this.archiveMessage(message.id);
    return filter.archive;
  }

  async getSignatures(): Promise<EmailSignature[]> {
    return [];
  }

  // IMAP keeps no label colors, so the app shows the same palette as Gmail.
  getDefaultLabelColor(colorName: LabelColorName): EmailLabelColor {
    return getGmailDefaultLabelColor(colorName);
  }

  async getContactPhotos(): Promise<Record<string, string>> {
    return {};
  }

  async getForwardingAddresses(): Promise<string[]> {
    return [];
  }

  async getSendAsAddresses(): Promise<SendAsAddress[]> {
    return [];
  }

  async searchContacts(query: string): Promise<EmailContact[]> {
    const sent = await this.findMailbox("sent");
    return normalizeContactCandidates(
      await searchImapContacts({
        emailAccountId: this.account.emailAccountId,
        query,
        withClient: (run) => this.withClient(run),
        sentPath: sent?.path ?? null,
        logger: this.logger,
      }),
    );
  }

  async watchEmails() {
    // Polling replaces push, see utils/imap/sync.ts.
    return null;
  }

  async unwatchEmails(_subscriptionId?: string) {}

  async syncLocalMail(
    _request: LocalMailSyncRequest,
    _context: { emailAccountId: string },
  ): Promise<LocalMailSyncResponse> {
    return { status: "unsupported", strategy: this.localMailSyncStrategy };
  }

  async getMailboxSyncPage(options: {
    after?: Date;
    cursor?: string;
    folderId?: string;
    limit: number;
  }): Promise<MailboxSyncPage> {
    const connectionId = this.account.connectionId;

    if (!options.cursor) {
      const latest = await prisma.imapChange.findFirst({
        where: { connectionId },
        orderBy: { id: "desc" },
        select: { id: true },
      });
      return {
        cursor: encodeSyncCursor(latest?.id ?? BigInt(0)),
        deletedMessageIds: [],
        hasMore: false,
        reset: false,
        upsertedMessages: [],
      };
    }

    const after = decodeSyncCursor(options.cursor);
    const { changesPrunedThrough } =
      await prisma.imapConnection.findUniqueOrThrow({
        where: { id: connectionId },
        select: { changesPrunedThrough: true },
      });
    if (after < changesPrunedThrough) {
      return {
        cursor: options.cursor,
        deletedMessageIds: [],
        hasMore: false,
        reset: true,
        upsertedMessages: [],
      };
    }

    const changes = await prisma.imapChange.findMany({
      where: { connectionId, id: { gt: after } },
      orderBy: { id: "asc" },
      take: options.limit + 1,
    });
    const page = changes.slice(0, options.limit);
    const finalKind = new Map(
      page.map(({ messageId, kind }) => [messageId, kind]),
    );
    const upsertIds = [...finalKind]
      .filter(([, kind]) => kind === "upsert")
      .map(([id]) => id);

    return {
      cursor: encodeSyncCursor(page.at(-1)?.id ?? after),
      deletedMessageIds: [...finalKind]
        .filter(([, kind]) => kind === "delete")
        .map(([id]) => id),
      hasMore: changes.length > options.limit,
      reset: false,
      upsertedMessages: await this.getMessagesBatch(upsertIds),
    };
  }

  // --- Internals ---

  private async withClient<T>(run: (client: ImapFlow) => Promise<T>) {
    try {
      return await withImapClient(this.account, this.logger, run);
    } catch (error) {
      if (isAuthenticationFailure(error)) {
        await markImapDisconnected(this.account.emailAccountId);
      }
      throw error;
    }
  }

  private async findRows(where: {
    id?: string | { in: string[] };
    rfc822MessageId?: string;
    threadId?: string;
  }): Promise<MessageRow[]> {
    return prisma.imapMessage.findMany({
      where: { ...where, connectionId: this.account.connectionId },
      include: messageRowInclude,
      // Date headers have second precision, so messages in one thread can tie.
      orderBy: { uid: "asc" },
    });
  }

  // Label folders hold copies, which are not extra messages of the thread.
  private async findThreadRows(threadId: string) {
    const rows = await this.findRows({ threadId });
    return rows.filter((row) => !isLabelFolder(row.mailbox.path));
  }

  private async readThread(threadId: string, includeDrafts?: boolean) {
    const rows = await this.findThreadRows(threadId);
    const visible = includeDrafts
      ? rows
      : rows.filter((row) => row.mailbox.role !== "drafts");
    return sortChronologically(await this.readRows(visible));
  }

  private async readRows(rows: MessageRow[]): Promise<ParsedMessage[]> {
    if (!rows.length) return [];

    const folderLabels = await this.loadFolderLabels(rows);
    const messages = await this.withClient(async (client) => {
      const parsed: ParsedMessage[] = [];

      for (const group of groupByMailbox(rows)) {
        const lock = await client.getMailboxLock(group.path, {
          readOnly: true,
        });
        try {
          const byUid = new Map(group.rows.map((row) => [row.uid, row]));
          for await (const item of client.fetch(
            group.rows.map((row) => row.uid).join(","),
            { uid: true, flags: true, internalDate: true, source: true },
            { uid: true },
          )) {
            const row = byUid.get(BigInt(item.uid));
            if (!row || !item.source) continue;

            const flags = [...(item.flags ?? [])];
            parsed.push(
              toParsedMessage({
                id: row.id,
                threadId: row.threadId,
                mailboxPath: row.mailbox.path,
                modseq: item.modseq,
                internalDate: new Date(item.internalDate ?? Date.now()),
                labelIds: getMessageLabelIds({
                  flags,
                  role: row.mailbox.role as ImapMailboxRole | null,
                  labels: this.labelsOf(row, flags, folderLabels),
                }),
                mail: await simpleParser(item.source),
              }),
            );
          }
        } finally {
          lock.release();
        }
      }

      return parsed;
    });

    // Callers hand results to code that assumes the requested order.
    const position = new Map(rows.map((row, index) => [row.id, index]));
    return messages.toSorted(
      (a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0),
    );
  }

  private labelsOf(
    row: MessageRow,
    flags: string[],
    folderLabels: Map<string, string[]>,
  ) {
    switch (this.account.labelStrategy) {
      case "keywords":
        return flags.flatMap((flag) => keywordToLabel(flag) ?? []);
      case "folders":
        return folderLabels.get(row.rfc822MessageId ?? "") ?? [];
      default:
        return row.labels;
    }
  }

  private async loadFolderLabels(rows: MessageRow[]) {
    const labels = new Map<string, string[]>();
    if (this.account.labelStrategy !== "folders") return labels;

    const copies = await prisma.imapMessage.findMany({
      where: {
        connectionId: this.account.connectionId,
        rfc822MessageId: {
          in: rows.flatMap((row) => row.rfc822MessageId ?? []),
        },
      },
      select: {
        rfc822MessageId: true,
        mailbox: { select: { path: true } },
      },
    });
    for (const copy of copies) {
      if (!copy.rfc822MessageId || !isLabelFolder(copy.mailbox.path)) continue;
      const list = labels.get(copy.rfc822MessageId) ?? [];
      labels.set(copy.rfc822MessageId, [...list, copy.mailbox.path]);
    }
    return labels;
  }

  private async toThreads(messages: ParsedMessage[]): Promise<EmailThread[]> {
    const threadIds = [...new Set(messages.map((item) => item.threadId))];
    const threads: EmailThread[] = [];
    for (const threadId of threadIds) {
      const members = await this.readThread(threadId, false);
      threads.push(toThread(threadId, members));
    }
    return threads;
  }

  private async searchMailbox({
    mailbox,
    criteria,
    sender,
    maxResults = DEFAULT_PAGE_SIZE,
    pageToken,
  }: {
    mailbox: { id: string; path: string };
    criteria: SearchObject;
    sender?: string;
    maxResults?: number;
    pageToken?: string;
  }) {
    const offset = pageToken ? Number(pageToken) : 0;

    return this.withClient(async (client) => {
      const uids = sender
        ? await searchUidsByAddress(
            client,
            mailbox.path,
            "from",
            sender,
            criteria,
          )
        : await searchUids(client, mailbox.path, criteria);
      const newestFirst = uids.toReversed();
      const page = newestFirst.slice(offset, offset + maxResults);
      const rows = await ensureIndexed({
        client,
        connectionId: this.account.connectionId,
        mailboxId: mailbox.id,
        uids: page,
      });
      const rank = new Map(page.map((uid, index) => [BigInt(uid), index]));

      return {
        rows: rows.toSorted(
          (a, b) => (rank.get(a.uid) ?? 0) - (rank.get(b.uid) ?? 0),
        ) as MessageRow[],
        nextPageToken:
          offset + maxResults < newestFirst.length
            ? String(offset + maxResults)
            : undefined,
      };
    });
  }

  private async findThreadQueryRows(
    query: ThreadsQuery | undefined,
    scope: ThreadScope,
    page: { maxResults?: number; pageToken?: string },
  ) {
    const usesLabelFolders = this.account.labelStrategy === "folders";
    const folderPath =
      query?.folderId ??
      (usesLabelFolders && !scope.role ? scope.labels[0] : undefined);
    const singleFolder =
      folderPath || (scope.role && (usesLabelFolders || !scope.labels.length));

    if (singleFolder) {
      const mailbox = folderPath
        ? await this.findMailboxByPath(folderPath)
        : await this.findMailbox(scope.role as ImapMailboxRole);
      if (!mailbox) return { rows: [], nextPageToken: undefined };

      return this.searchMailbox({
        mailbox,
        criteria: {
          ...(query?.fromEmail && { from: query.fromEmail }),
          ...(scope.unread && { seen: false }),
          ...(scope.starred && { flagged: true }),
          ...(query?.before && { before: query.before }),
          ...(query?.after && { since: query.after }),
        },
        ...page,
      });
    }

    return this.findIndexedRows(scope, page);
  }

  /** Labels live on single messages, and those can sit in any folder. */
  private async findIndexedRows(
    scope: ThreadScope,
    page: { maxResults?: number; pageToken?: string },
  ) {
    const offset = page.pageToken ? Number(page.pageToken) : 0;
    const maxResults = page.maxResults ?? DEFAULT_PAGE_SIZE;
    const rows = await prisma.imapMessage.findMany({
      where: {
        connectionId: this.account.connectionId,
        mailbox: scope.role
          ? { role: scope.role }
          : {
              OR: [{ role: null }, { role: { notIn: ["trash", "junk"] } }],
              NOT: { path: { startsWith: "Labels/" } },
            },
        ...this.labelRowFilter(scope.labels),
        ...(scope.starred && { flags: { has: "\\Flagged" } }),
      },
      include: messageRowInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: offset,
      take: maxResults + 1,
    });

    return {
      rows: rows.slice(0, maxResults) as MessageRow[],
      nextPageToken:
        rows.length > maxResults ? String(offset + maxResults) : undefined,
    };
  }

  private labelRowFilter(labels: string[]) {
    if (!labels.length) return {};
    return this.account.labelStrategy === "database"
      ? { labels: { hasEvery: labels } }
      : { flags: { hasEvery: labels.map(labelToKeyword) } };
  }

  private async resolveLabelIds(names: readonly string[] | null | undefined) {
    if (!names?.length) return [];
    const labels = await this.getLabels();
    const wanted = new Set(names.map((name) => this.toComparableLabel(name)));
    return labels
      .filter((label) => wanted.has(label.name.toLowerCase()))
      .map((label) => label.id);
  }

  private toComparableLabel(name: string) {
    return (
      this.account.labelStrategy === "folders" ? toLabelFolderName(name) : name
    ).toLowerCase();
  }

  private async listAllMessages(options: {
    maxResults?: number;
    pageToken?: string;
  }) {
    const offset = options.pageToken ? Number(options.pageToken) : 0;
    const maxResults = options.maxResults ?? DEFAULT_PAGE_SIZE;
    const rows = await prisma.imapMessage.findMany({
      where: { connectionId: this.account.connectionId },
      include: messageRowInclude,
      orderBy: { id: "asc" },
      skip: offset,
      take: maxResults + 1,
    });
    const page = rows.slice(0, maxResults);

    return {
      messages: await this.readRows(
        page.filter((row) => !isLabelFolder(row.mailbox.path)),
      ),
      nextPageToken:
        rows.length > maxResults ? String(offset + maxResults) : undefined,
    };
  }

  private async saveFilter(filter: {
    from: string;
    archive: boolean;
    addLabelIds: string[];
  }) {
    const from = normalizeAddress(filter.from);
    const { connectionId } = this.account;
    await prisma.imapFilter.upsert({
      where: { connectionId_from: { connectionId, from } },
      create: { ...filter, connectionId, from },
      update: { archive: filter.archive, addLabelIds: filter.addLabelIds },
    });
  }

  private async recordChanges(messageIds: string[], kind: "upsert" | "delete") {
    await prisma.imapChange.createMany({
      data: messageIds.map((messageId) => ({
        connectionId: this.account.connectionId,
        messageId,
        kind,
      })),
    });
  }

  private async countInRole(
    role: ImapMailboxRole,
    field: "from" | "to",
    address: string,
    limit: number,
    criteria?: SearchObject,
  ) {
    const mailbox = await this.findMailbox(role);
    if (!mailbox) return 0;
    return this.withClient(async (client) => {
      const uids = await searchUidsByAddress(
        client,
        mailbox.path,
        field,
        address,
        criteria,
      );
      return Math.min(uids.length, limit);
    });
  }

  private async moveFromSender(fromEmail: string, role: ImapMailboxRole) {
    const inbox = await this.requireMailbox("inbox");
    const target = await this.requireMailboxOrCreate(role);
    return this.withClient(async (client) => {
      const uids = await searchUidsByAddress(
        client,
        inbox.path,
        "from",
        fromEmail,
      );
      if (!uids.length) return 0;

      const lock = await client.getMailboxLock(inbox.path);
      try {
        for (let start = 0; start < uids.length; start += UID_CHUNK) {
          // The sync moves the matching rows, so their app IDs stay valid.
          const moved = await client.messageMove(
            uids.slice(start, start + UID_CHUNK).join(","),
            target.path,
            { uid: true },
          );
          if (!moved) throw new Error("IMAP move failed");
        }
      } finally {
        lock.release();
      }
      return uids.length;
    });
  }

  private async moveToRole(rows: MessageRow[], role: ImapMailboxRole) {
    const target = await this.requireMailboxOrCreate(role);
    await this.moveRows(rows, target.path);
  }

  private async moveRows(rows: MessageRow[], targetPath: string) {
    const toMove = rows.filter((row) => row.mailbox.path !== targetPath);
    if (!toMove.length) return;

    const { connectionId } = this.account;

    await this.withClient(async (client) => {
      for (const group of groupByMailbox(toMove)) {
        const lock = await client.getMailboxLock(group.path);
        try {
          const result = await client.messageMove(
            group.rows.map((row) => row.uid).join(","),
            targetPath,
            { uid: true },
          );
          if (!result) throw new Error("IMAP move failed");

          // Without COPYUID the next sync re-links the rows by Message-ID.
          if (result.uidMap && result.uidValidity) {
            // A folder created for this move is not indexed yet, and the next
            // action on these rows must already find them there.
            const target = await prisma.imapMailbox.upsert({
              where: { connectionId_path: { connectionId, path: targetPath } },
              create: {
                connectionId,
                path: targetPath,
                uidValidity: BigInt(result.uidValidity),
              },
              update: {},
              select: { id: true },
            });
            await prisma.$transaction(
              group.rows.flatMap((row) => {
                const uid = result.uidMap?.get(Number(row.uid));
                if (!uid) return [];
                return prisma.imapMessage.update({
                  where: { id: row.id },
                  data: {
                    mailboxId: target.id,
                    uid: BigInt(uid),
                    uidValidity: BigInt(result.uidValidity as bigint),
                  },
                });
              }),
            );
          }
        } finally {
          lock.release();
        }
      }
    });
    await this.recordChanges(
      toMove.map((row) => row.id),
      "upsert",
    );
  }

  private async setFlag(rows: MessageRow[], flag: string, enabled: boolean) {
    await this.withClient(async (client) => {
      for (const group of groupByMailbox(rows)) {
        const lock = await client.getMailboxLock(group.path);
        try {
          const uids = group.rows.map((row) => row.uid).join(",");
          if (enabled) {
            await client.messageFlagsAdd(uids, [flag], { uid: true });
          } else {
            await client.messageFlagsRemove(uids, [flag], { uid: true });
          }
        } finally {
          lock.release();
        }
      }
    });
  }

  private async applyLabel(threadId: string, labelId: string) {
    await this.labelRows(await this.findThreadRows(threadId), labelId);
  }

  private async labelRows(rows: MessageRow[], labelId: string) {
    switch (this.account.labelStrategy) {
      case "keywords":
        await this.setFlag(rows, labelToKeyword(labelId), true);
        return;
      case "folders":
        await this.withClient(async (client) => {
          for (const group of groupByMailbox(rows)) {
            const lock = await client.getMailboxLock(group.path);
            try {
              await client.messageCopy(
                group.rows.map((row) => row.uid).join(","),
                labelId,
                { uid: true },
              );
            } finally {
              lock.release();
            }
          }
        });
        return;
      default:
        await prisma.$transaction(
          rows
            .filter((row) => !row.labels.includes(labelId))
            .map((row) =>
              prisma.imapMessage.update({
                where: { id: row.id },
                data: { labels: { push: labelId } },
              }),
            ),
        );
    }
  }

  private async unlabelRows(rows: MessageRow[], labelId: string) {
    switch (this.account.labelStrategy) {
      case "keywords":
        await this.setFlag(rows, labelToKeyword(labelId), false);
        return;
      case "folders": {
        const copies = await prisma.imapMessage.findMany({
          where: {
            connectionId: this.account.connectionId,
            mailbox: { path: labelId },
            rfc822MessageId: {
              in: rows.flatMap((row) => row.rfc822MessageId ?? []),
            },
          },
          include: messageRowInclude,
        });
        await this.withClient(async (client) => {
          for (const group of groupByMailbox(copies)) {
            const lock = await client.getMailboxLock(group.path);
            try {
              await client.messageDelete(
                group.rows.map((row) => row.uid).join(","),
                { uid: true },
              );
            } finally {
              lock.release();
            }
          }
        });
        return;
      }
      default:
        await prisma.$transaction(
          rows.map((row) =>
            prisma.imapMessage.update({
              where: { id: row.id },
              data: {
                labels: row.labels.filter((label) => label !== labelId),
              },
            }),
          ),
        );
    }
  }

  private labelCriteria(labelId: string): SearchObject {
    return this.account.labelStrategy === "keywords"
      ? { keyword: labelToKeyword(labelId) }
      : {};
  }

  private async findMailbox(role: ImapMailboxRole) {
    return prisma.imapMailbox.findFirst({
      where: { connectionId: this.account.connectionId, role },
      select: { id: true, path: true },
    });
  }

  private async requireMailbox(role: ImapMailboxRole) {
    const mailbox = await this.findMailbox(role);
    if (!mailbox) throw new Error(`The mailbox has no ${role} folder`);
    return mailbox;
  }

  private async findMailboxByPath(path: string) {
    return prisma.imapMailbox.findUnique({
      where: {
        connectionId_path: { connectionId: this.account.connectionId, path },
      },
      select: { id: true, path: true },
    });
  }

  private async requireMailboxByPath(path: string) {
    const mailbox = await this.findMailboxByPath(path);
    if (!mailbox) throw new Error("Folder not found");
    return mailbox;
  }

  private async requireMailboxOrCreate(role: ImapMailboxRole) {
    const mailbox = await this.findMailbox(role);
    if (mailbox) return mailbox;
    if (role !== "archive") return this.requireMailbox(role);

    // Servers without an archive folder are common, and archiving must still work.
    const path = await this.getOrCreateFolderIdByName("Archive");
    return { id: "", path };
  }

  private async resolveSearchMailbox(options: {
    folderId?: string;
    folder?: "spam" | "trash";
    mailboxSearch?: ProviderMailboxSearch;
  }) {
    if (options.folderId) return this.requireMailboxByPath(options.folderId);
    const scope = options.folder ?? options.mailboxSearch?.mailbox;
    const role = scope ? SEARCH_SCOPE_ROLES[scope] : "inbox";
    return this.requireMailbox(role ?? "inbox");
  }

  private async deliver(options: Mail.Options) {
    const { raw, messageId } = await composeMessage({
      ...options,
      from: this.account.email,
    });
    await sendRawMessage(
      this.account,
      {
        from: this.account.email,
        to: [options.to, options.cc, options.bcc].flatMap((value) =>
          parseRecipients(value as string | undefined),
        ),
      },
      raw,
    );
    await this.storeSentCopy(raw, messageId);
    return { messageId };
  }

  // Some servers file sent mail themselves, so a blind APPEND would duplicate it.
  private async storeSentCopy(raw: Buffer, messageId: string) {
    // Proton Mail Bridge files it up to 40 seconds later, too late for the search below.
    if (this.account.labelStrategy === "folders") return;

    const mailbox = await this.findMailbox("sent");
    if (!mailbox) return;

    await this.withClient(async (client) => {
      const existing = await searchUids(client, mailbox.path, {
        header: { "message-id": messageId },
      });
      if (!existing.length) {
        await client.append(mailbox.path, raw, ["\\Seen"]);
      }
    });
  }

  private async storeDraft(options: Mail.Options, threadId?: string) {
    const mailbox = await this.requireMailbox("drafts");
    const { raw, messageId } = await composeMessage({
      ...options,
      from: this.account.email,
    });
    const rfc822MessageId = parseMessageIds(messageId)[0] ?? null;
    const appended = await this.withClient((client) =>
      appendDraft(client, mailbox.path, raw, messageId),
    );
    const row = await prisma.imapMessage.create({
      data: {
        connectionId: this.account.connectionId,
        mailboxId: mailbox.id,
        uid: appended.uid,
        uidValidity: appended.uidValidity,
        rfc822MessageId,
        threadId:
          threadId ??
          resolveThread({
            messageId,
            references: null,
            inReplyTo: null,
            fallbackKey: messageId,
            knownThreadIds: new Map(),
          }).threadId,
      },
    });
    await this.recordChanges([row.id], "upsert");
    return { id: row.id };
  }

  // IMAP messages are immutable, so an edit is an append plus a delete. The row
  // follows the new UID, which keeps the draft ID stable for the composer.
  private async replaceDraft(row: MessageRow, raw: Buffer) {
    const messageId = `<${row.rfc822MessageId ?? ""}>`;
    const appended = await this.withClient(async (client) => {
      const result = await appendDraft(
        client,
        row.mailbox.path,
        raw,
        messageId,
        row.uid,
      );
      const lock = await client.getMailboxLock(row.mailbox.path);
      try {
        await client.messageDelete(String(row.uid), { uid: true });
      } finally {
        lock.release();
      }
      return result;
    });
    await prisma.imapMessage.update({
      where: { id: row.id },
      data: { uid: appended.uid, uidValidity: appended.uidValidity },
    });
    await this.recordChanges([row.id], "upsert");
  }

  private async rewriteDraftAttachments(
    draftId: string,
    change: (list: Mail.Attachment[]) => Mail.Attachment[],
  ) {
    await this.rewriteDraft(draftId, (mail, attachments) => ({
      to: addressText(mail.to),
      cc: addressText(mail.cc),
      bcc: addressText(mail.bcc),
      subject: mail.subject,
      html: mail.html || undefined,
      attachments: change(attachments),
    }));
  }

  private async rewriteDraft(
    draftId: string,
    build: (mail: ParsedMail, attachments: Mail.Attachment[]) => Mail.Options,
  ) {
    const row = await this.requireDraftRow(draftId);

    const source = await this.withClient((client) => readSource(client, row));
    const mail = await simpleParser(source);
    const { raw } = await composeMessage({
      ...build(mail, toMailAttachments(mail)),
      from: this.account.email,
      messageId: mail.messageId,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
    });
    await this.replaceDraft(row, raw);
  }

  // Message and draft IDs are the same kind of ID here, so only the folder
  // tells a draft from received mail that must never be rewritten or sent.
  private async requireDraftRow(draftId: string) {
    const [row] = await this.findRows({ id: draftId });
    if (row?.mailbox.role !== "drafts") {
      throw new DraftNotFoundError("Could not find this draft.");
    }
    return row;
  }

  private async requireDraftAttachments(draftId: string) {
    const result = await this.getDraftAttachments(draftId);
    if (!result) throw new Error("Draft not found");
    return result;
  }

  private async readAttachments(messageId: string) {
    return toMailAttachments(
      await simpleParser(await this.getMessageSource(messageId)),
    );
  }

  private async findAttachment(messageId: string, attachmentId: string) {
    const mail = await simpleParser(await this.getMessageSource(messageId));
    const attachment = mail.attachments.find(
      (item, index) => (item.partId ?? String(index)) === attachmentId,
    );
    if (!attachment) throw new Error("Attachment not found");
    return attachment;
  }
}

const ROLE_SYSTEM_FOLDERS: Record<string, OutlookSystemFolder> = {
  inbox: "INBOX",
  sent: "SENT",
  drafts: "DRAFT",
  trash: "TRASH",
  junk: "SPAM",
  archive: "ARCHIVE",
};

const SEARCH_SCOPE_ROLES: Record<string, ImapMailboxRole | undefined> = {
  inbox: "inbox",
  sent: "sent",
  drafts: "drafts",
  spam: "junk",
  trash: "trash",
  archive: "archive",
};

// The mail client treats a provider 404 as "gone" instead of retrying forever.
function notFoundError() {
  return Object.assign(new Error("Message not found"), { status: 404 });
}

function encodeSyncCursor(id: bigint) {
  return `imap:${id}`;
}

function decodeSyncCursor(cursor: string) {
  const match = cursor.match(/^imap:(\d+)$/);
  if (!match) throw new InvalidMailboxSyncCursorError();
  return BigInt(match[1]);
}

function toLabel(id: string, name: string): EmailLabel {
  return { id, name, type: "user" };
}

function toThread(threadId: string, messages: ParsedMessage[]): EmailThread {
  return {
    id: threadId,
    messages,
    snippet: messages.at(-1)?.snippet ?? "",
  };
}

function sortChronologically(messages: ParsedMessage[]) {
  return messages.toSorted(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
}

// Stale UIDVALIDITY rows point at nothing valid until the next sync relinks them.
function groupByMailbox(rows: MessageRow[]) {
  const groups = new Map<string, { path: string; rows: MessageRow[] }>();
  for (const row of rows) {
    if (row.uidValidity !== row.mailbox.uidValidity) continue;
    const group = groups.get(row.mailboxId) ?? {
      path: row.mailbox.path,
      rows: [],
    };
    group.rows.push(row);
    groups.set(row.mailboxId, group);
  }
  return [...groups.values()];
}

async function searchUids(
  client: ImapFlow,
  path: string,
  criteria: SearchObject,
): Promise<number[]> {
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const query = Object.keys(criteria).length ? criteria : { all: true };
    const uids = await client.search(query, { uid: true });
    if (!Array.isArray(uids)) throw new Error("IMAP search failed");
    return uids;
  } finally {
    lock.release();
  }
}

// IMAP SEARCH FROM/TO matches substrings and display names, so a search for
// bob@example.com also returns notbob@example.com. The envelope decides.
async function searchUidsByAddress(
  client: ImapFlow,
  path: string,
  field: "from" | "to",
  address: string,
  criteria: SearchObject = {},
): Promise<number[]> {
  const wanted = normalizeAddress(address);
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const uids = await client.search(
      { ...criteria, [field]: wanted },
      { uid: true },
    );
    if (!Array.isArray(uids)) throw new Error("IMAP search failed");

    const exact: number[] = [];
    for (let start = 0; start < uids.length; start += UID_CHUNK) {
      for await (const message of client.fetch(
        uids.slice(start, start + UID_CHUNK).join(","),
        { uid: true, envelope: true },
        { uid: true },
      )) {
        const addresses = message.envelope?.[field] ?? [];
        if (addresses.some((item) => item.address?.toLowerCase() === wanted)) {
          exact.push(message.uid);
        }
      }
    }
    return exact;
  } finally {
    lock.release();
  }
}

async function readSource(client: ImapFlow, row: MessageRow) {
  const lock = await client.getMailboxLock(row.mailbox.path, {
    readOnly: true,
  });
  try {
    const message = await client.fetchOne(
      String(row.uid),
      { source: true },
      { uid: true },
    );
    if (message === false || !message.source) {
      throw new Error("Message not found");
    }
    return message.source;
  } finally {
    lock.release();
  }
}

async function appendDraft(
  client: ImapFlow,
  path: string,
  raw: Buffer,
  messageId: string,
  excludeUid?: bigint,
) {
  const result = await client.append(path, raw, ["\\Draft", "\\Seen"]);
  if (!result) throw new Error("Could not save the draft");

  if (result.uid && result.uidValidity) {
    return { uid: BigInt(result.uid), uidValidity: BigInt(result.uidValidity) };
  }

  // Servers without UIDPLUS do not report the new UID.
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const uids = await client.search(
      { header: { "message-id": messageId } },
      { uid: true },
    );
    const uid = Array.isArray(uids)
      ? uids.filter((value) => BigInt(value) !== excludeUid).at(-1)
      : undefined;
    const uidValidity = client.mailbox ? client.mailbox.uidValidity : undefined;
    if (!uid || !uidValidity) throw new Error("Could not locate the draft");
    return { uid: BigInt(uid), uidValidity };
  } finally {
    lock.release();
  }
}

/** Multiple criteria of one object are AND-ed by IMAP SEARCH. */
export function parseImapQuery(query: string | undefined): SearchObject {
  if (!query) return {};

  const criteria: SearchObject = {};
  const text: string[] = [];
  const tokens = query.match(/(?:[^\s"]+:"[^"]*"|"[^"]*"|\S+)/g) ?? [];

  for (const token of tokens) {
    const match = token.match(/^([a-z]+):(.*)$/i);
    const key = match?.[1].toLowerCase();
    const value = match?.[2].replace(/^"|"$/g, "") ?? "";

    if (key === "from") criteria.from = value;
    else if (key === "to") criteria.to = value;
    else if (key === "subject") criteria.subject = value;
    else if (key === "before") criteria.before = new Date(value);
    else if (key === "after" || key === "since")
      criteria.since = new Date(value);
    else if (token === "is:unread") criteria.seen = false;
    else if (token === "is:read") criteria.seen = true;
    else if (token === "is:starred") criteria.flagged = true;
    else if (token === "has:attachment") {
      criteria.header = { "content-type": "multipart/mixed" };
    } else text.push(token.replace(/^"|"$/g, ""));
  }

  if (text.length) criteria.text = text.join(" ");
  return criteria;
}

function mailboxSearchCriteria(
  search: ProviderMailboxSearch | undefined,
): SearchObject {
  if (!search) return {};
  return {
    ...(search.read !== undefined && { seen: search.read }),
    ...(search.starred !== undefined && { flagged: search.starred }),
    ...(search.mailbox === "starred" && { flagged: true }),
  };
}

function buildReplyHeaders(email: ParsedMessage) {
  const messageId = email.headers["message-id"];
  return {
    to: email.headers["reply-to"] || email.headers.from,
    subject: prefixSubject("Re:", email.subject),
    inReplyTo: messageId,
    references: joinReferences(email.headers.references, messageId),
  };
}

function joinReferences(
  references: string | undefined,
  messageId: string | undefined,
) {
  return [references, messageId].filter(Boolean).join(" ") || undefined;
}

function prefixSubject(prefix: string, subject: string) {
  return subject.toLowerCase().startsWith(prefix.toLowerCase())
    ? subject
    : `${prefix} ${subject}`;
}

function buildForwardHtml(email: ParsedMessage, content: string | undefined) {
  const { from, date, subject, to } = email.headers;
  const quoted = email.textHtml ?? escapeHtml(email.textPlain ?? "");

  return [
    content ?? "",
    "<br><br>---------- Forwarded message ----------<br>",
    `From: ${escapeHtml(from)}<br>`,
    `Date: ${escapeHtml(date)}<br>`,
    `Subject: ${escapeHtml(subject)}<br>`,
    `To: ${escapeHtml(to)}<br><br>`,
    quoted,
  ].join("");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeAddress(value: string) {
  return extractEmailAddress(value).toLowerCase();
}

function toMailAttachment(attachment: {
  filename: string;
  content: string;
  contentType: string;
}): Mail.Attachment {
  return {
    filename: attachment.filename,
    content: attachment.content,
    contentType: attachment.contentType,
    encoding: "base64",
  };
}

function toMailAttachments(mail: ParsedMail): Mail.Attachment[] {
  return mail.attachments.map((attachment) => ({
    filename: attachment.filename,
    content: attachment.content,
    contentType: attachment.contentType,
  }));
}

function addressText(addresses: AddressObject | AddressObject[] | undefined) {
  if (!addresses) return;
  return [addresses]
    .flat()
    .map((item) => item.text)
    .join(", ");
}
