import { createHash } from "node:crypto";

export function parseMessageIds(header: string | null | undefined): string[] {
  if (!header) return [];
  const bracketed = [...header.matchAll(/<([^<>\s]+)>/g)].map(
    (match) => match[1],
  );
  if (bracketed.length > 0) return bracketed;
  return header.split(/[\s,]+/).filter(Boolean);
}

/**
 * `knownThreadIds` maps Message-IDs already indexed for this account to their
 * thread. `childThreadIds` holds threads of messages that reference this one,
 * which covers a reply being synced before its parent.
 */
export function resolveThread({
  messageId,
  references,
  inReplyTo,
  fallbackKey,
  knownThreadIds,
  childThreadIds = [],
}: {
  messageId: string | null | undefined;
  references: string | null | undefined;
  inReplyTo: string | null | undefined;
  fallbackKey: string;
  knownThreadIds: ReadonlyMap<string, string>;
  childThreadIds?: readonly string[];
}): { threadId: string; mergeThreadIds: string[] } {
  const ownId = parseMessageIds(messageId)[0];
  const ancestors = [
    ...parseMessageIds(references),
    ...parseMessageIds(inReplyTo),
  ];
  const related = ownId ? [...ancestors, ownId] : ancestors;

  const matches = [
    ...new Set([
      ...related.flatMap((id) => knownThreadIds.get(id) ?? []),
      ...childThreadIds,
    ]),
  ];

  if (matches.length > 0) {
    const [threadId, ...mergeThreadIds] = matches;
    return { threadId, mergeThreadIds };
  }

  const root = ancestors[0] ?? ownId;
  // The key is unique per message, so mail without any ID never shares a thread.
  return {
    threadId: hashThreadKey(root ?? `no-message-id:${fallbackKey}`),
    mergeThreadIds: [],
  };
}

function hashThreadKey(key: string) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

export type ThreadInput = {
  fallbackKey: string;
  inReplyTo: string | null;
  messageId: string | null;
  references: string | null;
};

export type IndexedThreadMember = {
  references: readonly string[];
  rfc822MessageId: string | null;
  threadId: string;
};

/**
 * Assigns threads for a batch in any arrival order, so a reply stored in Sent
 * joins correctly even when its parent is scanned later in the same run.
 * `merges` maps each absorbed thread ID to the one that replaces it.
 */
export function assignThreads(
  messages: readonly ThreadInput[],
  existing: readonly IndexedThreadMember[],
): { threadIds: string[]; merges: Map<string, string> } {
  const knownThreadIds = new Map<string, string>();
  const childThreads = new Map<string, Set<string>>();
  const merges = new Map<string, string>();
  const canonical = (threadId: string) => {
    let current = threadId;
    while (merges.has(current)) current = merges.get(current) as string;
    return current;
  };
  const remember = (member: IndexedThreadMember) => {
    if (member.rfc822MessageId) {
      knownThreadIds.set(member.rfc822MessageId, member.threadId);
    }
    for (const ancestor of member.references) {
      const threads = childThreads.get(ancestor) ?? new Set();
      childThreads.set(ancestor, threads.add(member.threadId));
    }
  };

  for (const member of existing) remember(member);

  const assigned = messages.map((message) => {
    const ownId = parseMessageIds(message.messageId)[0] ?? null;
    const ancestors = [
      ...parseMessageIds(message.references),
      ...parseMessageIds(message.inReplyTo),
    ];
    const { threadId, mergeThreadIds } = resolveThread({
      ...message,
      knownThreadIds: new Map(
        [...knownThreadIds].map(([id, thread]) => [id, canonical(thread)]),
      ),
      childThreadIds: [
        ...new Set(
          [...(ownId ? (childThreads.get(ownId) ?? []) : [])].map(canonical),
        ),
      ],
    });

    for (const merged of mergeThreadIds) merges.set(merged, threadId);
    remember({ rfc822MessageId: ownId, references: ancestors, threadId });
    return threadId;
  });

  return { threadIds: assigned.map(canonical), merges };
}
