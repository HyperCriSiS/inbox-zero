import type { ImapMailboxRole } from "@/utils/imap/message";

export type MailboxSyncMode = "baseline" | "reset" | "incremental" | "idle";

export type StoredMailboxState = {
  highestModseq: bigint | null;
  lastSeenUid: bigint;
  uidValidity: bigint;
};

export type LiveMailboxState = {
  highestModseq?: bigint;
  uidNext: number;
  uidValidity: bigint;
};

export type IndexedMessage = {
  flags: string[];
  id: string;
  objectId: string | null;
  rfc822MessageId: string | null;
  uid: bigint;
  uidValidity: bigint;
};

export type IncomingMessage = {
  objectId: string | null;
  rfc822MessageId: string | null;
  uid: bigint;
};

const INTAKE_ROLES: readonly (ImapMailboxRole | null)[] = ["inbox", "sent"];

export function planMailboxSync(
  stored: StoredMailboxState | null,
  live: LiveMailboxState,
): MailboxSyncMode {
  if (!stored) return "baseline";
  if (stored.uidValidity !== live.uidValidity) return "reset";

  const hasNewUids = BigInt(live.uidNext) - BigInt(1) > stored.lastSeenUid;
  // Deletions do not move UIDNEXT, so without MODSEQ every run must compare UIDs.
  const unchanged =
    live.highestModseq !== undefined &&
    live.highestModseq === stored.highestModseq;

  return !hasNewUids && unchanged ? "idle" : "incremental";
}

/**
 * Splits what the server holds against what is indexed. A vanished message may
 * only have moved, so the caller matches it against other mailboxes before
 * treating it as deleted.
 */
export function diffMailbox({
  mode,
  serverUids,
  indexed,
  lastSeenUid,
  liveUidValidity,
}: {
  mode: Exclude<MailboxSyncMode, "idle">;
  serverUids: readonly bigint[];
  indexed: readonly IndexedMessage[];
  lastSeenUid: bigint;
  liveUidValidity: bigint;
}): { newUids: bigint[]; vanished: IndexedMessage[] } {
  const onServer = new Set(serverUids);
  const known = new Set(
    indexed
      .filter((message) => message.uidValidity === liveUidValidity)
      .map((message) => message.uid),
  );

  const vanished = indexed.filter(
    (message) =>
      message.uidValidity !== liveUidValidity || !onServer.has(message.uid),
  );

  // `n:*` always returns the highest UID, so the search result alone would
  // report the last message as new on every run.
  const newUids = serverUids
    .filter((uid) => !known.has(uid))
    .filter((uid) => mode !== "incremental" || uid > lastSeenUid)
    .toSorted(compareBigInt);

  return { newUids, vanished };
}

/**
 * Pairs vanished rows with messages that appeared elsewhere, so a moved message
 * keeps its app ID and is not reported as new mail.
 */
export function matchMovedMessages<T extends IncomingMessage>(
  vanished: readonly IndexedMessage[],
  incoming: readonly T[],
): {
  moved: { from: IndexedMessage; to: T }[];
  created: T[];
  deleted: IndexedMessage[];
} {
  const unmatched = [...vanished];
  const moved: { from: IndexedMessage; to: T }[] = [];
  const created: T[] = [];

  for (const message of incoming) {
    const index = findVanishedIndex(unmatched, message);
    if (index === -1) {
      created.push(message);
    } else {
      moved.push({ from: unmatched[index], to: message });
      unmatched.splice(index, 1);
    }
  }

  return { moved, created, deleted: unmatched };
}

/** Finds what another client changed, such as mail read in Thunderbird. */
export function diffFlags(
  indexed: readonly IndexedMessage[],
  live: readonly { flags: readonly string[]; uid: bigint }[],
) {
  const byUid = new Map(indexed.map((message) => [message.uid, message]));
  return live.flatMap(({ uid, flags }) => {
    const message = byUid.get(uid);
    if (!message || sameFlags(message.flags, flags)) return [];
    return [{ id: message.id, flags: [...flags] }];
  });
}

/**
 * Only fresh arrivals run rules. Baselines and resets replay existing mail, and
 * a copy of an indexed message has already been handled.
 */
export function shouldEnqueueForRules({
  mode,
  role,
  alreadyIndexedElsewhere,
}: {
  mode: Exclude<MailboxSyncMode, "idle">;
  role: ImapMailboxRole | null;
  alreadyIndexedElsewhere: boolean;
}) {
  return (
    mode === "incremental" &&
    INTAKE_ROLES.includes(role) &&
    !alreadyIndexedElsewhere
  );
}

function findVanishedIndex(
  vanished: readonly IndexedMessage[],
  message: IncomingMessage,
) {
  if (message.objectId) {
    const index = vanished.findIndex(
      (row) => row.objectId === message.objectId,
    );
    if (index !== -1) return index;
  }
  if (!message.rfc822MessageId) return -1;
  return vanished.findIndex(
    (row) => row.rfc822MessageId === message.rfc822MessageId,
  );
}

function sameFlags(a: readonly string[], b: readonly string[]) {
  const known = new Set(a);
  return a.length === b.length && b.every((flag) => known.has(flag));
}

function compareBigInt(a: bigint, b: bigint) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
