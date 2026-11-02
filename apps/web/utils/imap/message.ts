import type {
  AddressObject,
  Attachment as MailAttachment,
  ParsedMail,
} from "mailparser";
import { GmailLabel } from "@/utils/gmail/label";
import type { Attachment, ParsedMessage } from "@/utils/types";

export type ImapMailboxRole =
  | "inbox"
  | "sent"
  | "drafts"
  | "trash"
  | "junk"
  | "archive";

const SNIPPET_LENGTH = 200;

const ROLE_LABELS: Partial<Record<ImapMailboxRole, string>> = {
  inbox: GmailLabel.INBOX,
  sent: GmailLabel.SENT,
  drafts: GmailLabel.DRAFT,
  trash: GmailLabel.TRASH,
  junk: GmailLabel.SPAM,
};

/** Gives IMAP state the label vocabulary the rest of the app reads. */
export function getMessageLabelIds({
  flags,
  role,
  labels,
}: {
  flags: Iterable<string>;
  role: ImapMailboxRole | null;
  labels: readonly string[];
}): string[] {
  const flagSet = new Set(flags);
  const roleLabel = role ? ROLE_LABELS[role] : undefined;

  return [
    ...(roleLabel ? [roleLabel] : []),
    ...(flagSet.has("\\Seen") ? [] : [GmailLabel.UNREAD]),
    ...(flagSet.has("\\Flagged") ? [GmailLabel.STARRED] : []),
    ...labels,
  ];
}

export function toParsedMessage({
  id,
  threadId,
  mailboxPath,
  modseq,
  labelIds,
  internalDate,
  mail,
}: {
  id: string;
  threadId: string;
  mailboxPath: string;
  modseq: bigint | number | null | undefined;
  labelIds: string[];
  internalDate: Date;
  mail: ParsedMail;
}): ParsedMessage {
  const subject = singleLine(mail.subject);
  const date = (mail.date ?? internalDate).toISOString();
  const attachments = mail.attachments.filter((item) => !item.related);
  const inline = mail.attachments.filter((item) => item.related);
  const textHtml = mail.html || undefined;

  return {
    id,
    threadId,
    historyId: String(modseq ?? 0),
    date,
    internalDate: String(internalDate.getTime()),
    subject,
    snippet: singleLine(mail.text).slice(0, SNIPPET_LENGTH),
    textPlain: mail.text,
    textHtml,
    bodyContentType: textHtml ? "html" : "text",
    labelIds,
    parentFolderId: mailboxPath,
    hasAttachment: attachments.length > 0,
    attachments: attachments.map(toAttachment),
    inline: inline.map(toAttachment),
    headers: {
      from: formatAddresses(mail.from),
      to: formatAddresses(mail.to),
      subject,
      date,
      ...optionalHeader("cc", formatAddresses(mail.cc)),
      ...optionalHeader("bcc", formatAddresses(mail.bcc)),
      ...optionalHeader("reply-to", formatAddresses(mail.replyTo)),
      ...optionalHeader("message-id", mail.messageId),
      ...optionalHeader("in-reply-to", mail.inReplyTo),
      ...optionalHeader("references", [mail.references ?? []].flat().join(" ")),
      ...optionalHeader(
        "list-unsubscribe",
        getRawHeader(mail, "list-unsubscribe"),
      ),
      ...optionalHeader(
        "list-unsubscribe-post",
        getRawHeader(mail, "list-unsubscribe-post"),
      ),
    },
  };
}

function toAttachment(attachment: MailAttachment, index: number): Attachment {
  return {
    // The position is stable because a stored message never changes.
    attachmentId: attachment.partId ?? String(index),
    filename: singleLine(attachment.filename) || "attachment",
    mimeType: attachment.contentType,
    size: attachment.size,
    headers: {
      "content-description": "",
      "content-disposition": attachment.contentDisposition,
      "content-id": attachment.cid ?? "",
      "content-transfer-encoding": "",
      "content-type": attachment.contentType,
    },
  };
}

function formatAddresses(
  addresses: AddressObject | AddressObject[] | undefined,
): string {
  if (!addresses) return "";
  return singleLine(
    [addresses]
      .flat()
      .map((item) => item.text)
      .join(", "),
  );
}

function optionalHeader<K extends string>(key: K, value: string | undefined) {
  return value ? ({ [key]: singleLine(value) } as Record<K, string>) : {};
}

function getRawHeader(mail: ParsedMail, name: string) {
  const line = mail.headerLines.find((header) => header.key === name)?.line;
  return line?.slice(line.indexOf(":") + 1);
}

// An RFC 2047 encoded word can decode to CRLF. Values read here flow back into
// outgoing headers, so a crafted subject must not be able to add new ones.
function singleLine(value: string | undefined) {
  return (value ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
}
