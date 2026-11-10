import { randomUUID } from "node:crypto";
import type { ImapFlow, ListResponse } from "imapflow";
import type { ImapProvider } from "@/utils/email/imap";
import { createEmailProvider } from "@/utils/email/provider";
import { detectFeatures } from "@/utils/imap/capabilities";
import {
  getImapConfig,
  isAuthenticationFailure,
  markImapDisconnected,
} from "@/utils/imap/config";
import {
  ImapConnectionPolicyError,
  withImapClient,
} from "@/utils/imap/connection";
import type { ImapMailboxRole } from "@/utils/imap/message";
import { isTemporaryFailure } from "@/utils/imap/temporary-failure";
import {
  type ImapMove,
  learnFromImapMoves,
} from "@/utils/imap/learn-from-moves";
import {
  diffFlags,
  diffMailbox,
  getScanStartUid,
  type IndexedMessage,
  isCopyOfHandledMail,
  isSecondCopyOfOwnMail,
  isSyncableFolder,
  matchMovedMessages,
  type MailboxSyncMode,
  planMailboxSync,
  shouldEnqueueForRules,
} from "@/utils/imap/sync-plan";
import {
  buildThreadMerges,
  type FetchedMessage,
  fetchThreadHeaders,
  resolveThreads,
  storedFlags,
  threadReferences,
} from "@/utils/imap/index-messages";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import {
  getWebhookEmailAccount,
  validateWebhookAccount,
} from "@/utils/webhook/validate-webhook-account";

const LEASE_MS = 10 * 60 * 1000;
const CHANGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RUN_BUDGET_MS = 4 * 60 * 1000;
// Older mail is indexed on demand. A baseline only needs enough for threading.
const BASELINE_WINDOW = 1000;
const MAX_NEW_MESSAGES_PER_RUN = 500;
const MAX_PENDING_PER_RUN = 100;
const MAX_ATTEMPTS = 5;
// A provider outage keeps a message pending without counting as an attempt.
const MAX_TEMPORARY_FAILURE_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const TEMPORARY_FAILURE_MESSAGE =
  "Temporarily unavailable, will retry; see server logs.";
const ACCOUNT_CONCURRENCY = 3;
const IMAP_SYNC_QUEUE = "imap-sync";

const SPECIAL_USE_ROLES: Record<string, ImapMailboxRole> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "junk",
  "\\Archive": "archive",
};

export type ImapSyncResult = {
  emailAccountId: string;
  processedCount: number;
  status: "success" | "skipped" | "disconnected" | "error";
};

type MailboxScan = {
  lastSeenUid: bigint;
  live: { highestModseq?: bigint; uidValidity: bigint };
  mailboxId: string;
  mode: Exclude<MailboxSyncMode, "idle">;
  path: string;
  role: ImapMailboxRole | null;
  truncated: boolean;
  vanished: IndexedMessage[];
  flagChanges: { id: string; flags: string[] }[];
  incoming: FetchedMessage[];
};

export async function enqueueImapAccountSync(
  emailAccountId: string,
  logger: Logger,
) {
  await enqueueBackgroundJob({
    topic: IMAP_SYNC_QUEUE,
    body: { emailAccountId },
    qstash: {
      queueName: IMAP_SYNC_QUEUE,
      parallelism: ACCOUNT_CONCURRENCY,
      path: "/api/imap/sync",
    },
    logger,
  });
}

/** Fans out so one slow mailbox cannot hold up the others or the cron request. */
export async function enqueueImapAccounts(logger: Logger) {
  const accounts = await prisma.imapConnection.findMany({
    where: { emailAccount: { account: { disconnectedAt: null } } },
    select: { emailAccountId: true },
  });

  for (const { emailAccountId } of accounts) {
    await enqueueImapAccountSync(emailAccountId, logger);
  }

  return accounts.length;
}

export async function syncImapAccount({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}): Promise<ImapSyncResult> {
  const owner = randomUUID();
  const claimed = await prisma.imapConnection.updateMany({
    where: {
      emailAccountId,
      OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: new Date() } }],
    },
    data: {
      syncLeaseOwner: owner,
      syncLeaseUntil: new Date(Date.now() + LEASE_MS),
    },
  });
  if (!claimed.count) {
    return { emailAccountId, processedCount: 0, status: "skipped" };
  }

  try {
    const config = await getImapConfig(emailAccountId);
    const moves = await withImapClient(config, logger, (client) =>
      syncIndex({ client, emailAccountId, owner }),
    );
    await pruneChanges(emailAccountId);
    const processedCount = await processPendingMessages({
      emailAccountId,
      owner,
      logger,
    });
    await learnFromMovesSafely({ emailAccountId, moves, logger });
    await prisma.imapConnection.update({
      where: { emailAccountId },
      data: { lastSyncedAt: new Date(), lastSyncError: null },
    });
    return { emailAccountId, processedCount, status: "success" };
  } catch (error) {
    return recordSyncFailure({ emailAccountId, error, logger });
  } finally {
    await prisma.imapConnection.updateMany({
      where: { emailAccountId, syncLeaseOwner: owner },
      data: { syncLeaseOwner: null, syncLeaseUntil: null },
    });
  }
}

async function syncIndex({
  client,
  emailAccountId,
  owner,
}: {
  client: ImapFlow;
  emailAccountId: string;
  owner: string;
}) {
  const connection = await prisma.imapConnection.findUniqueOrThrow({
    where: { emailAccountId },
    select: {
      id: true,
      ruleFolders: true,
      mailboxes: {
        select: {
          id: true,
          path: true,
          uidValidity: true,
          lastSeenUid: true,
          highestModseq: true,
        },
      },
    },
  });
  const storedByPath = new Map(
    connection.mailboxes.map((mailbox) => [mailbox.path, mailbox]),
  );

  const listedFolders = await client.list();
  const folders = listedFolders.filter(isSyncableFolder);
  const scans: MailboxScan[] = [];
  const permanentFlags = await readInboxPermanentFlags(client);

  for (const folder of folders) {
    const lock = await client.getMailboxLock(folder.path, { readOnly: true });
    try {
      const mailbox = client.mailbox;
      if (!mailbox) continue;

      const stored = storedByPath.get(folder.path) ?? null;
      const live = {
        uidValidity: mailbox.uidValidity,
        uidNext: mailbox.uidNext,
        exists: mailbox.exists,
        highestModseq: mailbox.highestModseq,
      };
      const mode = planMailboxSync(stored, live);
      if (mode === "idle") continue;

      scans.push(
        await scanMailbox({
          client,
          connectionId: connection.id,
          folder,
          stored,
          live,
          mode,
          scanIndex: scans.length,
        }),
      );
    } finally {
      lock.release();
    }
  }

  // A renamed or removed folder leaves rows behind that may have moved too.
  const livePaths = new Set(folders.map((folder) => folder.path));
  const removedMailboxes = connection.mailboxes.filter(
    (mailbox) => !livePaths.has(mailbox.path),
  );
  const orphaned = await prisma.imapMessage.findMany({
    where: { mailboxId: { in: removedMailboxes.map((mailbox) => mailbox.id) } },
    select: indexedMessageSelect,
  });

  return commitScans({
    connectionId: connection.id,
    owner,
    scans,
    orphaned,
    removedMailboxIds: removedMailboxes.map((mailbox) => mailbox.id),
    ruleFolders: connection.ruleFolders,
    features: detectFeatures({
      capabilities: client.capabilities.keys(),
      permanentFlags,
      // Not the syncable subset: Proton's `Labels` root cannot be selected.
      folderPaths: listedFolders.map((folder) => folder.path),
    }),
    capabilities: [...client.capabilities.keys()],
  });
}

async function scanMailbox({
  client,
  connectionId,
  folder,
  stored,
  live,
  mode,
  scanIndex,
}: {
  client: ImapFlow;
  connectionId: string;
  folder: ListResponse;
  stored: {
    highestModseq: bigint | null;
    id: string;
    lastSeenUid: bigint;
  } | null;
  live: {
    exists: number;
    highestModseq?: bigint;
    uidNext: number;
    uidValidity: bigint;
  };
  mode: Exclude<MailboxSyncMode, "idle">;
  scanIndex: number;
}): Promise<MailboxScan> {
  const indexed = stored
    ? await prisma.imapMessage.findMany({
        where: { connectionId, mailboxId: stored.id },
        select: indexedMessageSelect,
      })
    : [];
  const lastSeenUid = stored?.lastSeenUid ?? BigInt(0);
  const liveUidValidity = live.uidValidity;

  // A baseline needs every UID. After that only the indexed range can change,
  // which keeps a large mailbox cheap on servers without CONDSTORE.
  const scanRange =
    mode === "incremental"
      ? `${getScanStartUid({ indexed, lastSeenUid, liveUidValidity })}:*`
      : "1:*";
  const serverUids = live.exists ? await searchUids(client, scanRange) : [];

  const { newUids, vanished } = diffMailbox({
    mode,
    serverUids,
    indexed,
    lastSeenUid,
    liveUidValidity,
  });

  const replayExisting = mode !== "incremental";
  const uidsToFetch = replayExisting
    ? newUids.slice(-BASELINE_WINDOW)
    : newUids.slice(0, MAX_NEW_MESSAGES_PER_RUN);
  const truncated = !replayExisting && uidsToFetch.length < newUids.length;

  const highestServerUid = serverUids.reduce(
    (highest, uid) => (uid > highest ? uid : highest),
    lastSeenUid,
  );

  return {
    mailboxId: stored?.id ?? randomUUID(),
    path: folder.path,
    role: getMailboxRole(folder),
    mode,
    live,
    vanished,
    truncated,
    flagChanges:
      mode === "incremental" && live.exists > 0
        ? diffFlags(
            indexed,
            await fetchLiveFlags(
              client,
              scanRange,
              stored?.highestModseq ?? null,
            ),
          )
        : [],
    // Stop at the last fetched UID so the rest arrives on the next run.
    lastSeenUid: truncated ? (uidsToFetch.at(-1) as bigint) : highestServerUid,
    incoming: await fetchThreadHeaders(client, uidsToFetch, scanIndex),
  };
}

/**
 * Everything lands in one transaction, so a crash replays the run instead of
 * losing mail: cursors never advance past messages that were not recorded.
 */
async function commitScans({
  connectionId,
  owner,
  scans,
  orphaned,
  removedMailboxIds,
  ruleFolders,
  features,
  capabilities,
}: {
  connectionId: string;
  owner: string;
  scans: MailboxScan[];
  orphaned: IndexedMessage[];
  removedMailboxIds: string[];
  ruleFolders: string[];
  features: ReturnType<typeof detectFeatures>;
  capabilities: string[];
}) {
  const incoming = scans.flatMap((scan) => scan.incoming);
  const { moved, created, deleted } = matchMovedMessages(
    [...scans.flatMap((scan) => scan.vanished), ...orphaned],
    incoming,
  );
  const previousPaths = await getMailboxPaths(moved.map(({ from }) => from.id));

  // A move into a mailbox beyond this run's page looks like a deletion, and
  // deleting would give that message a new ID and rerun its rules.
  const isComplete = !scans.some((scan) => scan.truncated);

  const { threadIds, merges, existing } = await resolveThreads(
    connectionId,
    created.map((message) => ({
      ...message,
      fallbackKey: `${scans[message.scanIndex].mailboxId}:${message.uid}`,
    })),
    deleted.map((row) => row.id),
  );
  const indexedCopies = new Map<
    string,
    { role: string | null; path: string }[]
  >();
  for (const { rfc822MessageId, mailbox } of existing) {
    if (!rfc822MessageId) continue;
    const copies = indexedCopies.get(rfc822MessageId) ?? [];
    indexedCopies.set(rfc822MessageId, [...copies, mailbox]);
  }
  // The client groups by thread, so absorbed messages must be reported again.
  const mergedMessages = merges.size
    ? await prisma.imapMessage.findMany({
        where: { connectionId, threadId: { in: [...merges.keys()] } },
        select: { id: true },
      })
    : [];

  const rows = created.map((message, index) => {
    const scan = scans[message.scanIndex];
    return {
      message,
      scan,
      row: {
        id: randomUUID(),
        connectionId,
        mailboxId: scan.mailboxId,
        uidValidity: scan.live.uidValidity,
        uid: message.uid,
        threadId: threadIds[index],
        rfc822MessageId: message.rfc822MessageId,
        objectId: message.objectId,
        flags: message.flags,
        references: threadReferences(message),
      },
    };
  });

  const enqueued = rows.filter(({ message, scan }) => {
    const copies = indexedCopies.get(message.rfc822MessageId ?? "") ?? [];
    const isRuleFolder = !scan.role && ruleFolders.includes(scan.path);
    return shouldEnqueueForRules({
      mode: scan.mode,
      role: scan.role,
      isRuleFolder,
      isSecondCopyOfOwnMail:
        isSecondCopyOfOwnMail(
          scan.role,
          copies.map(({ role }) => role),
        ) ||
        (isRuleFolder && isCopyOfHandledMail(copies, ruleFolders)),
    });
  });
  // Copies arriving in the same run: the inbox or Sent copy wins, then the
  // first chosen folder.
  const intakeIds = new Set(
    enqueued.flatMap(({ message, scan }) =>
      scan.role && message.rfc822MessageId ? [message.rfc822MessageId] : [],
    ),
  );
  const syncItems = enqueued
    .filter(({ message, scan }) => {
      const id = message.rfc822MessageId;
      if (scan.role || !id) return true;
      if (intakeIds.has(id)) return false;
      intakeIds.add(id);
      return true;
    })
    .map(({ row }) => ({ connectionId, messageId: row.id }));

  await prisma.$transaction([
    // Fails the whole run if another worker took over an expired lease.
    prisma.imapConnection.update({
      where: { id: connectionId, syncLeaseOwner: owner },
      data: {
        capabilities,
        labelStrategy: features.labelStrategy,
        syncLeaseUntil: new Date(Date.now() + LEASE_MS),
      },
    }),
    ...scans.map((scan) =>
      prisma.imapMailbox.upsert({
        where: { id: scan.mailboxId },
        create: {
          id: scan.mailboxId,
          connectionId,
          path: scan.path,
          role: scan.role,
          uidValidity: scan.live.uidValidity,
          lastSeenUid: scan.lastSeenUid,
          highestModseq: scan.live.highestModseq,
        },
        update: {
          role: scan.role,
          uidValidity: scan.live.uidValidity,
          lastSeenUid: scan.lastSeenUid,
          // A partial run must look changed next time, or the rest is skipped.
          highestModseq: scan.truncated ? null : scan.live.highestModseq,
        },
      }),
    ),
    ...moved.map(({ from, to }) => {
      const scan = scans[to.scanIndex];
      return prisma.imapMessage.update({
        where: { id: from.id },
        data: {
          mailboxId: scan.mailboxId,
          uidValidity: scan.live.uidValidity,
          uid: to.uid,
          objectId: to.objectId,
          flags: to.flags,
        },
      });
    }),
    prisma.imapMessage.createMany({ data: rows.map(({ row }) => row) }),
    ...scans
      .flatMap((scan) => scan.flagChanges)
      .map(({ id, flags }) =>
        prisma.imapMessage.update({ where: { id }, data: { flags } }),
      ),
    prisma.imapChange.createMany({
      data: [
        ...rows.map(({ row }) => row.id),
        ...moved.map(({ from }) => from.id),
        ...mergedMessages.map(({ id }) => id),
        ...scans.flatMap((scan) => scan.flagChanges.map(({ id }) => id)),
      ].map((messageId) => ({ connectionId, messageId, kind: "upsert" })),
    }),
    ...buildThreadMerges(connectionId, merges),
    prisma.imapSyncItem.createMany({ data: syncItems, skipDuplicates: true }),
    ...(isComplete
      ? [
          prisma.imapChange.createMany({
            data: deleted.map(({ id: messageId }) => ({
              connectionId,
              messageId,
              kind: "delete",
            })),
          }),
          prisma.imapMessage.deleteMany({
            where: { id: { in: deleted.map((row) => row.id) } },
          }),
          prisma.imapMailbox.deleteMany({
            where: { id: { in: removedMailboxIds } },
          }),
        ]
      : []),
  ]);

  return moved.map(({ from, to }): ImapMove => {
    const scan = scans[to.scanIndex];
    return {
      messageId: from.id,
      fromPath: previousPaths.get(from.id) ?? null,
      toPath: scan.path,
      toRole: scan.role,
    };
  });
}

async function getMailboxPaths(messageIds: string[]) {
  if (!messageIds.length) return new Map<string, string>();
  const rows = await prisma.imapMessage.findMany({
    where: { id: { in: messageIds } },
    select: { id: true, mailbox: { select: { path: true } } },
  });
  return new Map(rows.map((row) => [row.id, row.mailbox.path]));
}

// Learning is a side effect of the sync, so a failure must not fail the run.
async function learnFromMovesSafely({
  emailAccountId,
  moves,
  logger,
}: {
  emailAccountId: string;
  moves: ImapMove[];
  logger: Logger;
}) {
  if (!moves.length) return;
  try {
    const provider = await createEmailProvider({
      emailAccountId,
      provider: "imap",
      logger,
    });
    await learnFromImapMoves({ emailAccountId, moves, provider, logger });
  } catch (error) {
    logger.warn("Learning from IMAP moves failed", { error });
  }
}

// A client behind the pruned range gets a reset and bootstraps again.
async function pruneChanges(emailAccountId: string) {
  const connection = await prisma.imapConnection.findUniqueOrThrow({
    where: { emailAccountId },
    select: { id: true },
  });
  const newestExpired = await prisma.imapChange.findFirst({
    where: {
      connectionId: connection.id,
      createdAt: { lt: new Date(Date.now() - CHANGE_RETENTION_MS) },
    },
    orderBy: { id: "desc" },
    select: { id: true },
  });
  if (!newestExpired) return;

  await prisma.$transaction([
    prisma.imapChange.deleteMany({
      where: { connectionId: connection.id, id: { lte: newestExpired.id } },
    }),
    prisma.imapConnection.update({
      where: { id: connection.id },
      data: { changesPrunedThrough: newestExpired.id },
    }),
  ]);
}

async function processPendingMessages({
  emailAccountId,
  owner,
  logger,
}: {
  emailAccountId: string;
  owner: string;
  logger: Logger;
}) {
  const connection = await prisma.imapConnection.findUniqueOrThrow({
    where: { emailAccountId },
    select: {
      id: true,
      emailAccount: { select: { email: true } },
      syncItems: {
        where: { processedAt: null },
        orderBy: [{ attempts: "asc" }, { createdAt: "asc" }],
        take: MAX_PENDING_PER_RUN,
        select: { messageId: true, attempts: true, createdAt: true },
      },
    },
  });
  if (!connection.syncItems.length) return 0;

  const account = await getWebhookEmailAccount(
    { email: connection.emailAccount.email },
    logger,
  );
  const validation = await validateWebhookAccount(account, logger);
  if (!validation.success) {
    // Same as a dropped webhook: mail arriving without access is not replayed.
    await prisma.imapSyncItem.updateMany({
      where: { connectionId: connection.id, processedAt: null },
      data: { processedAt: new Date() },
    });
    return 0;
  }

  const { emailAccount, hasAutomationRules, hasAiAccess } = validation.data;
  const provider = (await createEmailProvider({
    emailAccountId,
    provider: "imap",
    logger,
  })) as ImapProvider;

  const started = Date.now();
  let processedCount = 0;

  for (const item of connection.syncItems) {
    if (Date.now() - started > RUN_BUDGET_MS) break;

    const owned = await prisma.imapConnection.updateMany({
      where: { id: connection.id, syncLeaseOwner: owner },
      data: { syncLeaseUntil: new Date(Date.now() + LEASE_MS) },
    });
    if (!owned.count) throw new Error("IMAP sync lease was lost");

    const key = {
      connectionId_messageId: {
        connectionId: connection.id,
        messageId: item.messageId,
      },
    };

    try {
      const [message] = await provider.getMessagesBatch([item.messageId]);
      const archivedByFilter = message
        ? await provider.applyFilters(message)
        : false;
      if (message && !archivedByFilter) {
        await processHistoryItem(
          { messageId: item.messageId, threadId: message.threadId, message },
          {
            provider,
            rules: emailAccount.rules,
            hasAutomationRules,
            hasAiAccess,
            isNewMessage: true,
            emailAccount: {
              ...emailAccount,
              account: { provider: "imap" },
            },
            logger: logger.with({ messageId: item.messageId }),
          },
        );
      }
      await prisma.imapSyncItem.update({
        where: key,
        data: { processedAt: new Date(), lastError: null },
      });
      processedCount += 1;
    } catch (error) {
      logger.error("IMAP message remains pending", {
        messageId: item.messageId,
        error,
      });

      // An overloaded or rate limited AI provider fails every message the
      // same way, so stop here and try again on a later poll without using up
      // the attempts. Only give up once the message has waited too long.
      if (
        isTemporaryFailure(error) &&
        Date.now() - item.createdAt.getTime() < MAX_TEMPORARY_FAILURE_AGE_MS
      ) {
        await prisma.imapSyncItem.update({
          where: key,
          data: { lastError: TEMPORARY_FAILURE_MESSAGE },
        });
        break;
      }

      const attempts = item.attempts + 1;
      await prisma.imapSyncItem.update({
        where: key,
        data: {
          attempts,
          lastError: "Message processing failed; see server logs.",
          // One broken message must not hold its place in the queue forever.
          ...(attempts >= MAX_ATTEMPTS ? { processedAt: new Date() } : {}),
        },
      });
    }
  }

  return processedCount;
}

async function recordSyncFailure({
  emailAccountId,
  error,
  logger,
}: {
  emailAccountId: string;
  error: unknown;
  logger: Logger;
}): Promise<ImapSyncResult> {
  const authenticationFailed = isAuthenticationFailure(error);
  logger.error("IMAP sync failed", { error, authenticationFailed });

  await prisma.imapConnection.update({
    where: { emailAccountId },
    data: { lastSyncError: getSafeSyncError(error, authenticationFailed) },
  });

  if (!authenticationFailed) {
    return { emailAccountId, processedCount: 0, status: "error" };
  }

  // Retrying a wrong password every minute gets the account locked or the IP banned.
  await markImapDisconnected(emailAccountId);
  return { emailAccountId, processedCount: 0, status: "disconnected" };
}

export function getMailboxRole(folder: {
  path: string;
  specialUse?: string;
}): ImapMailboxRole | null {
  if (folder.path.toUpperCase() === "INBOX") return "inbox";
  return folder.specialUse
    ? (SPECIAL_USE_ROLES[folder.specialUse] ?? null)
    : null;
}

/** CHANGEDSINCE keeps this cheap. Other servers report every flag, every run. */
async function fetchLiveFlags(
  client: ImapFlow,
  uidRange: string,
  sinceModseq: bigint | null,
) {
  const flags: { uid: bigint; flags: string[] }[] = [];
  for await (const message of client.fetch(
    uidRange,
    { uid: true, flags: true },
    { uid: true, ...(sinceModseq ? { changedSince: sinceModseq } : {}) },
  )) {
    flags.push({
      uid: BigInt(message.uid),
      flags: storedFlags(message.flags),
    });
  }
  return flags;
}

async function searchUids(client: ImapFlow, uidRange: string) {
  const uids = await client.search({ uid: uidRange }, { uid: true });
  if (!Array.isArray(uids)) throw new Error("IMAP search failed");
  return uids.map(BigInt);
}

// Stored and shown to the user, so raw server replies stay in the logs.
function getSafeSyncError(error: unknown, authenticationFailed: boolean) {
  if (authenticationFailed) return "The mail server rejected the login.";
  if (error instanceof ImapConnectionPolicyError) return error.message;
  return "Could not synchronize with the mail server.";
}

const indexedMessageSelect = {
  id: true,
  flags: true,
  uid: true,
  uidValidity: true,
  objectId: true,
  rfc822MessageId: true,
} as const;

// A read-only EXAMINE reports no permanent flags, so this needs a real SELECT.
async function readInboxPermanentFlags(client: ImapFlow) {
  const lock = await client.getMailboxLock("INBOX");
  try {
    return client.mailbox ? client.mailbox.permanentFlags : undefined;
  } finally {
    lock.release();
  }
}
