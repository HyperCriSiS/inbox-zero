import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { GmailLabel } from "@/utils/gmail/label";
import { getMessageLabelIds, toParsedMessage } from "@/utils/imap/message";

async function parse(raw: string) {
  const mail = await simpleParser(raw.replace(/\n/g, "\r\n"));
  return toParsedMessage({
    id: "message-1",
    threadId: "thread-1",
    mailboxPath: "INBOX",
    modseq: 7,
    labelIds: [],
    internalDate: new Date("2026-01-02T03:04:05Z"),
    mail,
  });
}

describe("getMessageLabelIds", () => {
  it("marks unseen inbox mail with the labels the app expects", () => {
    expect(
      getMessageLabelIds({ flags: [], role: "inbox", labels: [] }),
    ).toEqual([GmailLabel.INBOX, GmailLabel.UNREAD]);
  });

  it("leaves a read archived message without inbox or unread labels", () => {
    expect(
      getMessageLabelIds({
        flags: ["\\Seen"],
        role: "archive",
        labels: ["Newsletter"],
      }),
    ).toEqual(["Newsletter"]);
  });

  it("does not leak raw IMAP flags into labels", () => {
    expect(
      getMessageLabelIds({
        flags: ["\\Seen", "\\Flagged", "\\Answered"],
        role: "sent",
        labels: [],
      }),
    ).toEqual([GmailLabel.SENT, GmailLabel.STARRED]);
  });
});

describe("toParsedMessage", () => {
  it("maps headers, body and threading fields", async () => {
    const message = await parse(`From: Ana <ana@example.com>
To: me@example.com
Cc: bob@example.com
Reply-To: list@example.com
Subject: Hello
Message-ID: <reply@example.com>
In-Reply-To: <root@example.com>
References: <root@example.com>
List-Unsubscribe: <https://example.com/u>
Date: Fri, 02 Jan 2026 03:04:05 +0000
Content-Type: text/plain; charset=utf-8

Body text
`);

    expect(message.headers).toMatchObject({
      from: '"Ana" <ana@example.com>',
      cc: "bob@example.com",
      "reply-to": "list@example.com",
      "message-id": "<reply@example.com>",
      "in-reply-to": "<root@example.com>",
      references: "<root@example.com>",
      "list-unsubscribe": "<https://example.com/u>",
    });
    expect(message.textPlain?.trim()).toBe("Body text");
    expect(message.snippet).toBe("Body text");
  });

  it("cannot be used to inject headers through an encoded subject", async () => {
    const message = await parse(`From: a@example.com
To: b@example.com
Subject: =?UTF-8?Q?Hi=0D=0ABcc:_evil@example.com?=
Date: Fri, 02 Jan 2026 03:04:05 +0000

x
`);

    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.headers.subject).not.toMatch(/[\r\n]/);
  });

  it("lists file attachments", async () => {
    const message = await parse(`From: a@example.com
To: b@example.com
Subject: File
Date: Fri, 02 Jan 2026 03:04:05 +0000
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b"

--b
Content-Type: text/plain

Hi
--b
Content-Type: application/pdf; name="report.pdf"
Content-Disposition: attachment; filename="report.pdf"
Content-Transfer-Encoding: base64

JVBERi0=
--b--
`);

    expect(message.hasAttachment).toBe(true);
    expect(message.attachments?.[0]).toMatchObject({
      filename: "report.pdf",
      mimeType: "application/pdf",
    });
  });
});
