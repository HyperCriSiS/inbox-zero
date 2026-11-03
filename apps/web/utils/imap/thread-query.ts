import type { ImapMailboxRole } from "@/utils/imap/message";
import type { ThreadsQuery } from "@/utils/threads/validation";
import type { ParsedMessage } from "@/utils/types";

export type ThreadScope = {
  /** Custom labels that must all match. */
  labels: string[];
  /** The one folder to look in. Without one, every folder but spam and trash. */
  role: ImapMailboxRole | null;
  starred: boolean;
  unread: boolean;
};

const MAILBOX_LABELS: Record<string, ImapMailboxRole> = {
  INBOX: "inbox",
  SENT: "sent",
  DRAFT: "drafts",
  TRASH: "trash",
  SPAM: "junk",
};

const TYPE_LABELS: Record<string, string[]> = {
  inbox: ["INBOX"],
  sent: ["SENT"],
  draft: ["DRAFT"],
  trash: ["TRASH"],
  spam: ["SPAM"],
  starred: ["STARRED"],
  unread: ["UNREAD"],
  all: [],
};

/** Follows Gmail's semantics, which is what every caller of this query assumes. */
export function parseThreadQuery(query: ThreadsQuery | undefined): ThreadScope {
  const isArchive = query?.type === "archive";
  const requested = getRequestedLabels(query);

  const role = requested.flatMap((label) => MAILBOX_LABELS[label] ?? [])[0];

  return {
    labels: requested.filter(
      (label) =>
        !(label in MAILBOX_LABELS) && label !== "UNREAD" && label !== "STARRED",
    ),
    role: isArchive ? "archive" : (role ?? null),
    starred: requested.includes("STARRED"),
    unread: requested.includes("UNREAD") || !!query?.isUnread,
  };
}

/** What a stored message must satisfy once it is read back. */
export function matchesThreadFilter(
  message: Pick<ParsedMessage, "headers" | "internalDate" | "labelIds">,
  filter: {
    after?: Date | null;
    before?: Date | null;
    excludedLabels: readonly string[];
    fromEmail?: string | null;
    labels: readonly string[];
    unread: boolean;
  },
) {
  const labelIds = message.labelIds ?? [];
  const sentAt = Number(message.internalDate);

  return (
    filter.labels.every((label) => labelIds.includes(label)) &&
    !filter.excludedLabels.some((label) => labelIds.includes(label)) &&
    (!filter.unread || labelIds.includes("UNREAD")) &&
    (!filter.before || sentAt < filter.before.getTime()) &&
    (!filter.after || sentAt > filter.after.getTime()) &&
    (!filter.fromEmail ||
      message.headers.from
        .toLowerCase()
        .includes(filter.fromEmail.toLowerCase()))
  );
}

function getRequestedLabels(query: ThreadsQuery | undefined) {
  if (query?.labelIds?.length) return query.labelIds;
  if (query?.labelId) return [query.labelId];

  const type = query?.type;
  if (type === "archive") return [];
  if (!type || type === "undefined" || type === "null") return ["INBOX"];
  return TYPE_LABELS[type] ?? [type];
}
