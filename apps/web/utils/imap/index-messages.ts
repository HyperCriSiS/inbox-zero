import type { ImapFlow } from "imapflow";
import type { IncomingMessage } from "@/utils/imap/sync-plan";
import { assignThreads, parseMessageIds } from "@/utils/imap/thread";
import prisma from "@/utils/prisma";

const FETCH_CHUNK = 200;

export type FetchedMessage = IncomingMessage & {
  flags: string[];
  inReplyTo: string | null;
  referencesHeader: string | null;
  scanIndex: number;
};

export async function fetchThreadHeaders(
  client: ImapFlow,
  uids: bigint[],
  scanIndex: number,
): Promise<FetchedMessage[]> {
  const messages: FetchedMessage[] = [];

  for (let start = 0; start < uids.length; start += FETCH_CHUNK) {
    const range = uids.slice(start, start + FETCH_CHUNK).join(",");
    for await (const message of client.fetch(
      range,
      {
        uid: true,
        flags: true,
        emailId: true,
        headers: ["message-id", "references", "in-reply-to"],
      },
      { uid: true },
    )) {
      const headers = parseThreadHeaders(message.headers);
      messages.push({
        uid: BigInt(message.uid),
        flags: storedFlags(message.flags),
        objectId: message.emailId ?? null,
        rfc822MessageId: parseMessageIds(headers["message-id"])[0] ?? null,
        referencesHeader: headers.references ?? null,
        inReplyTo: headers["in-reply-to"] ?? null,
        scanIndex,
      });
    }
  }

  return messages;
}

// Recent differs per session, so comparing it would report changes forever.
export function storedFlags(flags: Iterable<string> | undefined) {
  return [...(flags ?? [])].filter((flag) => flag !== "Recent");
}

export function parseThreadHeaders(
  raw: Buffer | undefined,
): Record<string, string> {
  if (!raw) return {};
  const unfolded = raw.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  const headers: Record<string, string> = {};

  for (const line of unfolded.split(/\r?\n/)) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) headers[match[1].toLowerCase()] = match[2].trim();
  }

  return headers;
}

export function threadReferences(message: FetchedMessage) {
  return [
    ...parseMessageIds(message.referencesHeader),
    ...parseMessageIds(message.inReplyTo),
  ];
}

/** Looks up everything these messages connect to, then assigns their threads. */
export async function resolveThreads(
  connectionId: string,
  messages: (FetchedMessage & { fallbackKey: string })[],
  ignoredIds: string[] = [],
) {
  const existing = messages.length
    ? await prisma.imapMessage.findMany({
        where: {
          connectionId,
          id: { notIn: ignoredIds },
          OR: [
            {
              rfc822MessageId: {
                in: messages.flatMap((message) => [
                  ...(message.rfc822MessageId ? [message.rfc822MessageId] : []),
                  ...threadReferences(message),
                ]),
              },
            },
            {
              references: {
                hasSome: messages.flatMap(
                  (message) => message.rfc822MessageId ?? [],
                ),
              },
            },
          ],
        },
        select: { rfc822MessageId: true, references: true, threadId: true },
      })
    : [];

  const { threadIds, merges } = assignThreads(
    messages.map((message) => ({
      messageId: message.rfc822MessageId,
      references: message.referencesHeader,
      inReplyTo: message.inReplyTo,
      fallbackKey: message.fallbackKey,
    })),
    existing,
  );

  return { threadIds, merges, existing };
}

export function buildThreadMerges(
  connectionId: string,
  merges: Map<string, string>,
) {
  return [...merges].map(([from, to]) =>
    prisma.imapMessage.updateMany({
      where: { connectionId, threadId: from },
      data: { threadId: canonicalThread(to, merges) },
    }),
  );
}

function canonicalThread(threadId: string, merges: Map<string, string>) {
  let current = threadId;
  while (merges.has(current)) current = merges.get(current) as string;
  return current;
}

/**
 * Baselines only cover recent mail, so search results can reach older messages.
 * UIDs past the cursor stay with the sync, which must see them as new to run rules.
 */
export async function ensureIndexed({
  client,
  connectionId,
  mailboxId,
  uids,
}: {
  client: ImapFlow;
  connectionId: string;
  mailboxId: string;
  uids: number[];
}) {
  const mailbox = await prisma.imapMailbox.findUniqueOrThrow({
    where: { id: mailboxId },
    select: { path: true, uidValidity: true, lastSeenUid: true },
  });
  const wanted = uids.map(BigInt);
  const findRows = () =>
    prisma.imapMessage.findMany({
      where: {
        mailboxId,
        uidValidity: mailbox.uidValidity,
        uid: { in: wanted },
      },
      include: {
        mailbox: {
          select: { id: true, path: true, role: true, uidValidity: true },
        },
      },
    });

  const indexed = await findRows();
  const known = new Set(indexed.map((row) => row.uid));
  const missing = wanted.filter(
    (uid) => !known.has(uid) && uid <= mailbox.lastSeenUid,
  );
  if (!missing.length) return indexed;

  const lock = await client.getMailboxLock(mailbox.path, { readOnly: true });
  let fetched: FetchedMessage[];
  try {
    fetched = await fetchThreadHeaders(client, missing, 0);
  } finally {
    lock.release();
  }

  const { threadIds, merges } = await resolveThreads(
    connectionId,
    fetched.map((message) => ({
      ...message,
      fallbackKey: `${mailboxId}:${message.uid}`,
    })),
  );

  await prisma.$transaction([
    prisma.imapMessage.createMany({
      data: fetched.map((message, index) => ({
        connectionId,
        mailboxId,
        uidValidity: mailbox.uidValidity,
        uid: message.uid,
        threadId: threadIds[index],
        rfc822MessageId: message.rfc822MessageId,
        objectId: message.objectId,
        flags: message.flags,
        references: threadReferences(message),
      })),
      skipDuplicates: true,
    }),
    ...buildThreadMerges(connectionId, merges),
  ]);

  return findRows();
}
