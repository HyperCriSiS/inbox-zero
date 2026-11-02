/**
 * Integration test: IMAP sync and provider against real servers.
 *
 * Needs Postgres with migrations applied, Dovecot and an SMTP sink:
 *   docker run -d -e USER_PASSWORD=testpass -p 31143:31143 dovecot/dovecot
 *   docker run -d -p 31025:1025 -p 38025:8025 -e MP_SMTP_AUTH_ACCEPT_ANY=1 \
 *     -e MP_SMTP_AUTH_ALLOW_INSECURE=1 axllent/mailpit
 *
 * Usage:
 *   docker cp <dovecot>:/etc/ssl/certs/ssl-cert-snakeoil.pem dovecot.crt
 *   IMAP_TEST_CERT=dovecot.crt IMAP_ALLOW_PRIVATE_HOSTS=true \
 *     IMAP_ALLOW_PLAINTEXT=true pnpm test-integration imap-provider
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { ImapFlow } from "imapflow";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { ImapProvider } from "@/utils/email/imap";
import { getImapConfig } from "@/utils/imap/config";
import { syncImapAccount } from "@/utils/imap/sync";
import prisma from "@/utils/prisma";
import { processHistoryItem } from "@/utils/webhook/process-history-item";

vi.mock("@/utils/webhook/process-history-item", () => ({
  processHistoryItem: vi.fn(async () => undefined),
}));
vi.mock("@/utils/webhook/validate-webhook-account", () => ({
  getWebhookEmailAccount: vi.fn(async () => ({ rules: [] })),
  validateWebhookAccount: vi.fn(async (emailAccount) => ({
    success: true,
    data: { emailAccount, hasAutomationRules: true, hasAiAccess: true },
  })),
}));
vi.mock("@/utils/email/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/email/rate-limit")>()),
  assertProviderNotRateLimited: vi.fn(async () => undefined),
}));

const RUN = process.env.RUN_INTEGRATION_TESTS;
const IMAP_HOST = "127.0.0.1";
// IMAP_TEST_PLAIN runs against GreenMail, a server with far fewer extensions.
const PLAIN = !!process.env.IMAP_TEST_PLAIN;
const IMAP_PORT = Number(process.env.IMAP_TEST_PORT ?? 31_143);
const SMTP_PORT = 31_025;
const MAILPIT_API = "http://127.0.0.1:38025/api/v1";
const PASSWORD = "testpass";

vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(!RUN)("IMAP provider against a real server", () => {
  const username = `user-${randomUUID().slice(0, 8)}`;
  const email = `${username}@example.com`;
  const logger = createTestLogger();
  let userId: string;
  let emailAccountId: string;
  let connectionId: string;
  let provider: ImapProvider;
  let client: ImapFlow;

  const sync = () => syncImapAccount({ emailAccountId, logger });
  const row = (rfc822MessageId: string) =>
    prisma.imapMessage.findFirstOrThrow({
      where: { connectionId, rfc822MessageId },
      include: { mailbox: true },
    });
  const newMailCalls = () => vi.mocked(processHistoryItem).mock.calls.length;

  async function deliver(
    id: string,
    options: {
      folder?: string;
      subject?: string;
      references?: string;
      body?: string;
      extraHeaders?: string;
    } = {},
  ) {
    const lines = [
      "From: Ana <ana@example.org>",
      `To: ${email}`,
      `Subject: ${options.subject ?? `Subject ${id}`}`,
      `Message-ID: <${id}>`,
      `Date: ${new Date().toUTCString()}`,
      ...(options.references
        ? [
            `References: <${options.references}>`,
            `In-Reply-To: <${options.references}>`,
          ]
        : []),
      ...(options.extraHeaders ? [options.extraHeaders] : []),
      "Content-Type: text/plain; charset=utf-8",
      "",
      options.body ?? `Body of ${id}`,
      "",
    ];
    await client.append(
      options.folder ?? "INBOX",
      Buffer.from(lines.join("\r\n")),
    );
  }

  beforeAll(async () => {
    client = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: false,
      doSTARTTLS: !PLAIN,
      tls: { rejectUnauthorized: false },
      auth: { user: username, pass: PASSWORD },
      logger: false,
    });
    client.on("error", () => undefined);
    await client.connect();
    for (const path of ["Sent", "Drafts", "Trash", "Archive"]) {
      await client.mailboxCreate(path).catch(() => undefined);
    }
    await deliver("old@x", { subject: "Old mail" });

    const user = await prisma.user.create({ data: { email } });
    userId = user.id;
    const account = await prisma.account.create({
      data: {
        userId,
        provider: "imap",
        providerAccountId: email,
        type: "credential",
      },
    });
    const emailAccount = await prisma.emailAccount.create({
      data: { email, userId, accountId: account.id },
    });
    emailAccountId = emailAccount.id;
    const connection = await prisma.imapConnection.create({
      data: {
        emailAccountId,
        imapHost: IMAP_HOST,
        imapPort: IMAP_PORT,
        imapSecurity: PLAIN ? "none" : "starttls",
        tlsPinnedCertPem: PLAIN
          ? null
          : readFileSync(process.env.IMAP_TEST_CERT as string, "utf8"),
        smtpHost: IMAP_HOST,
        smtpPort: SMTP_PORT,
        smtpSecurity: "none",
        username,
        password: PASSWORD,
      },
    });
    connectionId = connection.id;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    await client?.logout().catch(() => undefined);
  });

  test("stores the password encrypted", async () => {
    const [stored] = await prisma.$queryRaw<{ password: string }[]>`
      SELECT password FROM "ImapConnection" WHERE id = ${connectionId}`;

    expect(stored.password).not.toContain(PASSWORD);
    expect((await getImapConfig(emailAccountId)).password).toBe(PASSWORD);
  });

  test("baseline indexes existing mail without running rules", async () => {
    const result = await sync();

    expect(result.status).toBe("success");
    expect(newMailCalls()).toBe(0);
    await expect(row("old@x")).resolves.toMatchObject({
      mailbox: { role: "inbox" },
    });

    const account = await getImapConfig(emailAccountId);
    if (!PLAIN) expect(account.labelStrategy).toBe("keywords");
    provider = new ImapProvider(account, logger);
  });

  test("a second run with nothing new changes nothing", async () => {
    await sync();

    expect(newMailCalls()).toBe(0);
    await expect(
      prisma.imapSyncItem.count({ where: { connectionId } }),
    ).resolves.toBe(0);
  });

  test("new mail runs rules once with the full body", async () => {
    await deliver("new@x", { body: "Full body text" });

    await sync();
    await sync();

    expect(newMailCalls()).toBe(1);
    const [input] = vi.mocked(processHistoryItem).mock.calls[0];
    expect(input.message?.textPlain).toContain("Full body text");
    expect(input.message?.labelIds).toEqual(
      expect.arrayContaining(["INBOX", "UNREAD"]),
    );
  });

  test("a reply joins the thread and both bodies are readable", async () => {
    await deliver("reply@x", { references: "new@x", body: "Reply text" });
    await sync();

    const original = await row("new@x");
    const thread = await provider.getThread(original.threadId);

    expect(thread.messages.map((item) => item.textPlain?.trim())).toEqual([
      "Full body text",
      "Reply text",
    ]);
  });

  test("a move in another client keeps the ID and is not new mail", async () => {
    const before = await row("old@x");
    const calls = newMailCalls();

    const lock = await client.getMailboxLock("INBOX");
    await client.messageMove(String(before.uid), "Archive", { uid: true });
    lock.release();
    await sync();

    const after = await row("old@x");
    expect(after.id).toBe(before.id);
    expect(after.mailbox.path).toBe("Archive");
    expect(newMailCalls()).toBe(calls);
    await expect(provider.getMessage(before.id)).resolves.toMatchObject({
      subject: "Old mail",
    });
  });

  test("a deletion in another client removes the row", async () => {
    await deliver("gone@x");
    await sync();
    const before = await row("gone@x");

    const lock = await client.getMailboxLock("INBOX");
    await client.messageDelete(String(before.uid), { uid: true });
    lock.release();
    await sync();

    await expect(
      prisma.imapMessage.count({ where: { id: before.id } }),
    ).resolves.toBe(0);
  });

  test("archiving keeps a valid ID for the next action", async () => {
    await deliver("act@x");
    await sync();
    const before = await row("act@x");

    await provider.archiveThread(before.threadId, email);

    const after = await row("act@x");
    expect(after.id).toBe(before.id);
    expect(after.mailbox.path).toBe("Archive");
    await expect(provider.getMessage(before.id)).resolves.toBeTruthy();

    await provider.unarchiveThread(before.threadId);
    expect((await row("act@x")).mailbox.role).toBe("inbox");
  });

  test("a label does not move the message and can be removed", async () => {
    await deliver("label@x");
    await sync();
    const target = await row("label@x");
    const label = await provider.createLabel("Rechnungen für 2026");

    await provider.labelMessage({
      messageId: target.id,
      labelId: label.id,
      labelName: label.name,
    });

    const labeled = await provider.getMessage(target.id);
    expect(labeled.labelIds).toContain("INBOX");
    expect(labeled.labelIds).toContain("Rechnungen für 2026");

    await provider.removeThreadLabel(target.threadId, label.id);
    expect((await provider.getMessage(target.id)).labelIds).not.toContain(
      "Rechnungen für 2026",
    );
  });

  test("read state and search use combined criteria", async () => {
    await deliver("needle@x", { subject: "Quarterly needle" });
    await deliver("other@x", { subject: "Quarterly report" });
    await sync();
    const target = await row("needle@x");

    await provider.markMessagesReadState([target.id], true);
    expect((await provider.getMessage(target.id)).labelIds).not.toContain(
      "UNREAD",
    );

    const { messages } = await provider.searchMessages({
      query: "from:ana@example.org subject:needle",
    });
    expect(messages.map((item) => item.id)).toEqual([target.id]);
  });

  test("attachments can be read", async () => {
    const raw = [
      "From: ana@example.org",
      `To: ${email}`,
      "Subject: With file",
      "Message-ID: <file@x>",
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "See file",
      "--b",
      'Content-Type: text/plain; name="note.txt"',
      'Content-Disposition: attachment; filename="note.txt"',
      "",
      "file content",
      "--b--",
      "",
    ].join("\r\n");
    await client.append("INBOX", Buffer.from(raw));
    await sync();
    const target = await row("file@x");

    const message = await provider.getMessage(target.id);
    const attachment = message.attachments?.[0];
    expect(attachment?.filename).toBe("note.txt");

    const { data } = await provider.getAttachment(
      target.id,
      attachment?.attachmentId ?? "",
    );
    expect(Buffer.from(data, "base64url").toString()).toContain("file content");
  });

  test("sending hides BCC from recipients and files a Sent copy", async () => {
    // A catching server is needed for the exact bytes: Mailpit adds its own Bcc
    // header for envelope-only recipients.
    const smtp = await startCapturingSmtpServer();
    const account = await getImapConfig(emailAccountId);
    const sender = new ImapProvider(
      { ...account, smtp: { ...account.smtp, port: smtp.port } },
      logger,
    );

    const { messageId } = await sender.sendEmailWithHtml({
      to: "Bob <bob@example.org>",
      bcc: "hidden@example.org",
      subject: "Hello",
      messageHtml: "<p>Hi</p>",
    });
    smtp.close();

    expect(smtp.recipients).toContain("hidden@example.org");
    expect(smtp.data.toLowerCase()).not.toContain("hidden@example.org");

    await sync();
    const sent = await row(messageId.replace(/[<>]/g, ""));
    expect(sent.mailbox.role).toBe("sent");
    const copy = await provider.getMessage(sent.id);
    expect(copy.headers.bcc).toContain("hidden@example.org");
  });

  test("draft edits keep the draft ID and sending removes it", async () => {
    await fetch(`${MAILPIT_API}/messages`, { method: "DELETE" });

    const { id } = await provider.createDraft({
      to: "bob@example.org",
      subject: "Draft",
      messageHtml: "<p>One</p>",
    });
    await provider.updateDraft(id, { messageHtml: "<p>Two</p>" });

    const draft = await provider.getDraft(id);
    expect(draft?.textHtml).toContain("Two");

    await sync();
    await expect(
      prisma.imapMessage.count({
        where: { connectionId, id },
      }),
    ).resolves.toBe(1);

    await provider.sendDraft(id);
    const list = await (await fetch(`${MAILPIT_API}/messages`)).json();
    expect(list.messages).toHaveLength(1);
    await expect(provider.getDraft(id)).resolves.toBeNull();
  });

  test.skipIf(PLAIN)("a recreated folder keeps IDs across a UIDVALIDITY change", async () => {
    await client.mailboxCreate("Projects");
    await deliver("kept@x", { folder: "Projects" });
    await sync();
    const before = await row("kept@x");
    const calls = newMailCalls();

    await client.mailboxDelete("Projects");
    await client.mailboxCreate("Projects");
    await deliver("kept@x", { folder: "Projects" });
    await sync();

    const after = await row("kept@x");
    expect(after.id).toBe(before.id);
    expect(after.uidValidity).not.toBe(before.uidValidity);
    expect(newMailCalls()).toBe(calls);
    await expect(provider.getMessage(before.id)).resolves.toBeTruthy();
  });

  test("the change feed reports new, changed, moved and deleted mail", async () => {
    await sync();
    const { cursor: start } = await provider.getMailboxSyncPage({ limit: 1 });

    await deliver("feed@x", { subject: "Feed mail" });
    await sync();
    const message = await row("feed@x");

    const created = await provider.getMailboxSyncPage({
      cursor: start,
      limit: 50,
    });
    expect(created.upsertedMessages.map((item) => item.id)).toEqual([
      message.id,
    ]);
    expect(created.hasMore).toBe(false);

    // Read in another client, which only the flag comparison can notice.
    const lock = await client.getMailboxLock("INBOX");
    await client.messageFlagsAdd(String(message.uid), ["\\Seen"], {
      uid: true,
    });
    lock.release();
    await sync();

    const read = await provider.getMailboxSyncPage({
      cursor: created.cursor,
      limit: 50,
    });
    expect(read.upsertedMessages[0]?.labelIds).not.toContain("UNREAD");

    await provider.archiveThread(message.threadId, email);
    const moved = await provider.getMailboxSyncPage({
      cursor: read.cursor,
      limit: 50,
    });
    expect(moved.upsertedMessages[0]?.labelIds).not.toContain("INBOX");

    const archivedUid = (await row("feed@x")).uid;
    const archiveLock = await client.getMailboxLock("Archive");
    await client.messageDelete(String(archivedUid), { uid: true });
    archiveLock.release();
    await sync();
    const deleted = await provider.getMailboxSyncPage({
      cursor: moved.cursor,
      limit: 50,
    });
    expect(deleted.deletedMessageIds).toEqual([message.id]);
  });

  test("the bootstrap lists every mailbox and rejects a foreign cursor", async () => {
    const { messages } = await provider.getMessagesWithPagination({
      includeDrafts: true,
      maxResults: 100,
    });
    const roles = new Set(messages.flatMap((item) => item.labelIds ?? []));

    expect(roles).toContain("INBOX");
    expect(roles).toContain("SENT");
    await expect(
      provider.getMailboxSyncPage({ cursor: "gmail:1", limit: 1 }),
    ).rejects.toThrow();
  });

  test("a missing message reports a 404 to the mail client", async () => {
    await expect(provider.getMessage("does-not-exist")).rejects.toMatchObject({
      status: 404,
    });
  });

  test("an auto-archive filter applies to new mail and skips rules", async () => {
    await provider.createAutoArchiveFilter({ from: "Filter <filter@example.org>" });
    const [filter] = await provider.getFiltersList();
    expect(filter.criteria?.from).toBe("filter@example.org");
    const calls = newMailCalls();

    await client.append(
      "INBOX",
      Buffer.from(
        [
          "From: Filter <filter@example.org>",
          `To: ${email}`,
          "Subject: Filtered",
          "Message-ID: <filtered@x>",
          `Date: ${new Date().toUTCString()}`,
          "",
          "x",
          "",
        ].join("\r\n"),
      ),
    );
    await sync();

    expect((await row("filtered@x")).mailbox.role).toBe("archive");
    expect(newMailCalls()).toBe(calls);

    await provider.deleteFilter(filter.id);
    await expect(provider.getFiltersList()).resolves.toEqual([]);
  });

  test("deleteDraft refuses anything that is not a draft", async () => {
    await deliver("keep@x");
    await sync();
    const target = await row("keep@x");

    await expect(provider.deleteDraft(target.id)).resolves.toBe(false);
    await expect(provider.getMessage(target.id)).resolves.toBeTruthy();
  });

  test("a client behind the pruned feed range is told to reset", async () => {
    const { cursor } = await provider.getMailboxSyncPage({ limit: 1 });
    await prisma.imapConnection.update({
      where: { id: connectionId },
      data: { changesPrunedThrough: BigInt(10_000_000) },
    });

    const page = await provider.getMailboxSyncPage({ cursor, limit: 10 });

    expect(page.reset).toBe(true);
    await prisma.imapConnection.update({
      where: { id: connectionId },
      data: { changesPrunedThrough: BigInt(0) },
    });
  });

  test("labels work without keywords, kept in the database", async () => {
    await deliver("dblabel@x");
    await sync();
    const target = await row("dblabel@x");
    const databaseLabels = new ImapProvider(
      { ...(await getImapConfig(emailAccountId)), labelStrategy: "database" },
      logger,
    );

    const label = await databaseLabels.createLabel("Nur Datenbank");
    await databaseLabels.labelMessage({
      messageId: target.id,
      labelId: label.id,
      labelName: label.name,
    });

    expect((await databaseLabels.getMessage(target.id)).labelIds).toContain(
      "Nur Datenbank",
    );
    await expect(databaseLabels.getLabels()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: label.id })]),
    );

    await databaseLabels.removeThreadLabel(target.threadId, label.id);
    expect((await databaseLabels.getMessage(target.id)).labelIds).not.toContain(
      "Nur Datenbank",
    );
  });

  test("labels work as folder copies, as on Proton Mail Bridge", async () => {
    await client.mailboxCreate("Labels").catch(() => undefined);
    await deliver("folderlabel@x");
    await sync();
    const target = await row("folderlabel@x");
    const folderLabels = new ImapProvider(
      { ...(await getImapConfig(emailAccountId)), labelStrategy: "folders" },
      logger,
    );

    const label = await folderLabels.createLabel("Arbeit");
    await sync();
    await folderLabels.labelMessage({
      messageId: target.id,
      labelId: label.id,
      labelName: label.name,
    });
    const calls = newMailCalls();
    await sync();

    expect(newMailCalls()).toBe(calls);
    const labeled = await folderLabels.getMessage(target.id);
    expect(labeled.labelIds).toContain("INBOX");
    expect(labeled.labelIds).toContain(label.id);
    const thread = await folderLabels.getThread(target.threadId);
    expect(thread.messages).toHaveLength(1);

    await folderLabels.removeThreadLabel(target.threadId, label.id);
    await sync();
    expect((await folderLabels.getMessage(target.id)).labelIds).not.toContain(
      label.id,
    );
  });

  test.skipIf(PLAIN)("a rejected password disconnects the account", async () => {
    await prisma.imapConnection.update({
      where: { id: connectionId },
      data: { password: "wrong" },
    });

    const result = await sync();

    expect(result.status).toBe("disconnected");
    const account = await prisma.account.findFirstOrThrow({
      where: { userId },
    });
    expect(account.disconnectedAt).not.toBeNull();
    const connection = await prisma.imapConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(connection.lastSyncError).not.toContain("wrong");
  });
});

async function startCapturingSmtpServer() {
  const CRLF = "\r\n";
  const capture = {
    data: "",
    recipients: [] as string[],
    port: 0,
    close: () => server.close(),
  };
  const server = createServer((socket) => {
    let inData = false;
    const reply = (text: string) => socket.write(`${text}${CRLF}`);
    socket.setEncoding("utf8");
    reply("220 test");
    socket.on("data", (chunk: string) => {
      if (inData) {
        capture.data += chunk;
        if (capture.data.endsWith(`${CRLF}.${CRLF}`)) {
          inData = false;
          reply("250 queued");
        }
        return;
      }
      for (const line of chunk.split(CRLF).filter(Boolean)) {
        const command = line.toUpperCase();
        if (command.startsWith("EHLO")) reply(`250-test${CRLF}250 AUTH PLAIN`);
        else if (command.startsWith("AUTH")) reply("235 ok");
        else if (command === "DATA") {
          inData = true;
          reply("354 go");
        } else if (command === "QUIT") {
          socket.end(`221 bye${CRLF}`);
        } else {
          const recipient = line.match(/^RCPT TO:<([^>]+)>/i)?.[1];
          if (recipient) capture.recipients.push(recipient);
          reply("250 ok");
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  capture.port = typeof address === "object" && address ? address.port : 0;
  return capture;
}
