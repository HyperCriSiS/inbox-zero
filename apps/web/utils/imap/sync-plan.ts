import { isLabelFolder } from "@/utils/imap/labels";
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
const VIRTUAL_FOLDER_FLAGS = ["\\All", "\\Flagged"];

/**
 * Virtual folders repeat messages that live elsewhere. The LIST flags decide,
 * because servers without SPECIAL-USE, like Proton Mail Bridge, still send them
 * while the client leaves `specialUse` empty.
 */
export function isSyncableFolder(folder: {
  flags: ReadonlySet<string>;
  specialUse?: string;
}) {
  return (
    !folder.flags.has("\\Noselect") &&
    !VIRTUAL_FOLDER_FLAGS.some(
      (flag) => folder.flags.has(flag) || folder.specialUse === flag,
    )
  );
}

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

/** Older messages are outside the index, so nothing below this can change it. */
export function getScanStartUid({
  indexed,
  lastSeenUid,
  liveUidValidity,
}: {
  indexed: readonly IndexedMessage[];
  lastSeenUid: bigint;
  liveUidValidity: bigint;
}) {
  return indexed.reduce<bigint>(
    (lowest, message) =>
      message.uidValidity === liveUidValidity && message.uid < lowest
        ? message.uid
        : lowest,
    lastSeenUid + BigInt(1),
  );
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
 * mail to oneself was handled when its first copy arrived. Besides the inbox,
 * the user can name folders that server-side filters such as Sieve fill.
 */
export function shouldEnqueueForRules({
  mode,
  role,
  isRuleFolder,
  isSecondCopyOfOwnMail,
}: {
  mode: Exclude<MailboxSyncMode, "idle">;
  role: ImapMailboxRole | null;
  isRuleFolder: boolean;
  isSecondCopyOfOwnMail: boolean;
}) {
  return (
    mode === "incremental" &&
    (INTAKE_ROLES.includes(role) || isRuleFolder) &&
    !isSecondCopyOfOwnMail
  );
}

/**
 * Folders the user can let run rules. System folders already do or must not,
 * and label folders only hold copies of mail that lives elsewhere.
 */
export function isRuleFolderCandidate(mailbox: {
  path: string;
  role: string | null;
}) {
  return !mailbox.role && !isLabelFolder(mailbox.path);
}

/**
 * Sieve can file a copy and keep one in the inbox, and other clients can copy
 * mail into a chosen folder. That mail was handled where it first arrived, so
 * a copy in a chosen folder only runs rules when no inbox, Sent or other
 * chosen folder already holds the same Message-ID.
 */
export function isCopyOfHandledMail(
  indexedCopies: readonly { role: string | null; path: string }[],
  ruleFolders: readonly string[],
) {
  return indexedCopies.some(
    (copy) =>
      copy.role === "inbox" ||
      copy.role === "sent" ||
      ruleFolders.includes(copy.path),
  );
}

/**
 * Mail to oneself shows up in Sent and in the inbox under one Message-ID. A
 * known Message-ID anywhere else proves nothing, because senders choose it,
 * and skipping on it would let a reused ID slip past every rule.
 */
export function isSecondCopyOfOwnMail(
  role: ImapMailboxRole | null,
  rolesOfIndexedCopies: readonly (string | null)[],
) {
  if (role === "inbox") return rolesOfIndexedCopies.includes("sent");
  if (role === "sent") return rolesOfIndexedCopies.includes("inbox");
  return false;
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
