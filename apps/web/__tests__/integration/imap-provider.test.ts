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
import { APICallError } from "ai";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { ImapFlow } from "imapflow";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { ImapProvider } from "@/utils/email/imap";
import { processAccountFollowUps } from "@/utils/follow-up/process";
import { withReviewBeforeDelete } from "@/utils/email/review-before-delete";
import { startImapIdle } from "@/utils/imap/idle";
import { cleanUpLabel } from "@/utils/label-cleanup/run-label-cleanup";
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
const PASSWORD = process.env.IMAP_TEST_PASSWORD ?? "testpass";

vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(!RUN)("IMAP provider against a real server", () => {
  // Dovecot creates users on login. Other servers need a prepared account.
  const username =
    process.env.IMAP_TEST_USER ?? `user-${randomUUID().slice(0, 8)}`;
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
      date?: Date;
      extraHeaders?: string;
    } = {},
  ) {
    const lines = [
      "From: Ana <ana@example.org>",
      `To: ${email}`,
      `Subject: ${options.subject ?? `Subject ${id}`}`,
      `Message-ID: <${id}>`,
      `Date: ${(options.date ?? new Date()).toUTCString()}`,
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
      [],
      options.date,
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

  test("new mail in a chosen folder runs rules, other folders do not", async () => {
    for (const path of ["Pakete", "Other"]) {
      await client.mailboxCreate(path).catch(() => undefined);
    }
    await sync();
    await prisma.imapConnection.update({
      where: { id: connectionId },
      data: { ruleFolders: ["Pakete"] },
    });
    const calls = newMailCalls();

    await deliver("parcel@x", { folder: "Pakete" });
    await deliver("other@x", { folder: "Other" });
    await sync();
    await sync();

    expect(newMailCalls()).toBe(calls + 1);
    const [input] = vi.mocked(processHistoryItem).mock.calls.at(-1) ?? [];
    expect(input?.messageId).toBe((await row("parcel@x")).id);
  });

  test("a copy in a chosen folder of mail that also reached the inbox runs rules once", async () => {
    const calls = newMailCalls();

    // Sieve `fileinto :copy`: both copies arrive in the same run.
    await deliver("sievecopy@x");
    await deliver("sievecopy@x", { folder: "Pakete" });
    await sync();
    // Copied into the chosen folder later, by another client.
    await deliver("sievecopy@x", { folder: "Pakete" });
    await sync();
    await sync();

    expect(newMailCalls()).toBe(calls + 1);
  });

  test("an AI outage keeps new mail pending without using up attempts", async () => {
    const callsBefore = newMailCalls();
    vi.mocked(processHistoryItem).mockRejectedValueOnce(
      new APICallError({
        message: "Service Unavailable",
        url: "https://api.example.com/v1/chat",
        requestBodyValues: {},
        statusCode: 503,
      }),
    );
    await deliver("outage-1@x");
    await deliver("outage-2@x");

    await sync();

    // The first failure stops the run, so the second message is not tried.
    expect(newMailCalls() - callsBefore).toBe(1);
    const ids = [(await row("outage-1@x")).id, (await row("outage-2@x")).id];
    const pending = await prisma.imapSyncItem.findMany({
      where: { connectionId, messageId: { in: ids }, processedAt: null },
    });
    expect(pending).toHaveLength(2);
    expect(pending.map((item) => item.attempts)).toEqual([0, 0]);

    await sync();

    expect(newMailCalls() - callsBefore).toBe(3);
    await expect(
      prisma.imapSyncItem.count({
        where: { connectionId, messageId: { in: ids }, processedAt: null },
      }),
    ).resolves.toBe(0);
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

  test("moving into and out of a rule's folder elsewhere is learned", async () => {
    const folder = await provider.getOrCreateFolderIdByName("Rechnungen");
    const rule = await prisma.rule.create({
      data: {
        emailAccountId,
        name: "Invoices",
        instructions: "Invoices and receipts",
        actions: { create: { type: "MOVE_FOLDER", folderId: folder } },
      },
    });
    await deliver("learn@x");
    await sync();
    const message = await row("learn@x");
    const feedback = () =>
      prisma.classificationFeedback.findMany({
        where: { emailAccountId, ruleId: rule.id, messageId: message.id },
        select: { eventType: true, sender: true },
        orderBy: { createdAt: "asc" },
      });

    let lock = await client.getMailboxLock("INBOX");
    await client.messageMove(String(message.uid), folder, { uid: true });
    lock.release();
    await sync();

    expect(await feedback()).toEqual([
      { eventType: "LABEL_ADDED", sender: "ana@example.org" },
    ]);

    const moved = await row("learn@x");
    lock = await client.getMailboxLock(folder);
    await client.messageMove(String(moved.uid), "INBOX", { uid: true });
    lock.release();
    await sync();

    expect(await feedback()).toEqual([
      { eventType: "LABEL_ADDED", sender: "ana@example.org" },
      { eventType: "LABEL_REMOVED", sender: "ana@example.org" },
    ]);
    await prisma.rule.delete({ where: { id: rule.id } });
  });

  test("IDLE reports new mail in the inbox without a poll", async () => {
    const onNewMail = vi.fn(async (_emailAccountId: string) => {});
    let watching = false;
    const idle = startImapIdle({
      logger,
      onNewMail,
      onWatching: (id) => {
        if (id === emailAccountId) watching = true;
      },
    });
    try {
      await vi.waitFor(() => expect(watching).toBe(true), {
        timeout: 20_000,
        interval: 100,
      });
      const started = Date.now();
      await deliver("idle@x");

      await vi.waitFor(
        () => expect(onNewMail).toHaveBeenCalledWith(emailAccountId),
        { timeout: 30_000, interval: 200 },
      );
      logger.info("IDLE latency", { ms: Date.now() - started });
      await sync();
      await expect(row("idle@x")).resolves.toBeTruthy();
    } finally {
      idle.stop();
    }
  }, 60_000);

  // GreenMail has no SPECIAL-USE, so no Sent folder, and no substring search.
  test.skipIf(PLAIN)(
    "contact suggestions come from people written to",
    async () => {
      const sentPath =
        (
          await prisma.imapMailbox.findFirst({
            where: { connectionId, role: "sent" },
            select: { path: true },
          })
        )?.path ?? "Sent";
      await client.append(
        sentPath,
        Buffer.from(
          [
            `From: ${email}`,
            "To: Bruno Beispiel <bruno@example.net>",
            "Cc: Carla <carla@example.net>",
            "Subject: Angebot",
            "Message-ID: <contacts@x>",
            `Date: ${new Date().toUTCString()}`,
            "",
            "Hallo",
            "",
          ].join("\r\n"),
        ),
        ["\\Seen"],
      );

      await expect(provider.searchContacts("bruno")).resolves.toEqual([
        { emailAddress: "bruno@example.net", name: "Bruno Beispiel" },
      ]);
      await expect(provider.searchContacts("carla")).resolves.toEqual([
        { emailAddress: "carla@example.net", name: "Carla" },
      ]);
      await expect(provider.searchContacts("b")).resolves.toEqual([]);
    },
  );

  test("moving mail into Junk elsewhere learns a cold emailer", async (context) => {
    await client.mailboxCreate("Junk").catch(() => undefined);
    await sync();
    const junk = await prisma.imapMailbox.findFirst({
      where: { connectionId, role: "junk" },
      select: { path: true },
    });
    // Only servers that mark the folder with SPECIAL-USE \Junk have a role.
    if (!junk) return context.skip();

    const coldRule = await prisma.rule.create({
      data: {
        emailAccountId,
        name: "Cold email",
        systemType: "COLD_EMAIL",
        instructions: "Unsolicited sales email",
        actions: { create: { type: "ARCHIVE" } },
      },
    });
    await client.append(
      "INBOX",
      Buffer.from(
        [
          "From: Seller <seller@cold.example>",
          `To: ${email}`,
          "Subject: Grow your revenue",
          "Message-ID: <cold@x>",
          `Date: ${new Date().toUTCString()}`,
          "",
          "Buy now",
          "",
        ].join("\r\n"),
      ),
    );
    await sync();
    const message = await row("cold@x");

    const lock = await client.getMailboxLock("INBOX");
    await client.messageMove(String(message.uid), junk.path, { uid: true });
    lock.release();
    await sync();

    const learned = await prisma.groupItem.findMany({
      where: { group: { rule: { id: coldRule.id } } },
      select: { value: true },
    });
    expect(learned.map((item) => item.value)).toContain("seller@cold.example");
    await prisma.rule.delete({ where: { id: coldRule.id } });
  });

  test("label cleanup clears only old mail under the label", async () => {
    const label = await provider.createLabel("Aufraeumen");
    const longAgo = new Date(Date.now() - 60 * 86_400_000);
    await deliver("cleanup-old@x", { date: longAgo });
    await deliver("cleanup-new@x");
    await sync();
    const oldRow = await row("cleanup-old@x");
    const newRow = await row("cleanup-new@x");
    await provider.labelMessage({
      messageId: oldRow.id,
      labelId: label.id,
      labelName: label.name,
    });
    await provider.labelMessage({
      messageId: newRow.id,
      labelId: label.id,
      labelName: label.name,
    });

    // Labels reach the index with the next sync, long before a daily run.
    await sync();

    const handled = await cleanUpLabel({
      provider,
      ownerEmail: email,
      labelId: label.id,
      action: "ARCHIVE",
      olderThan: new Date(Date.now() - 30 * 86_400_000),
      logger,
    });

    expect(handled).toBe(1);
    expect((await row("cleanup-old@x")).mailbox.role).toBe("archive");
    expect((await row("cleanup-new@x")).mailbox.role).toBe("inbox");
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

  test.skipIf(PLAIN)(
    "a recreated folder keeps IDs across a UIDVALIDITY change",
    async () => {
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
    },
  );

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
    await provider.createAutoArchiveFilter({
      from: "Filter <filter@example.org>",
    });
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

  test("bulk sender actions keep IDs after the next sync", async () => {
    const bulkMail = (id: string) =>
      Buffer.from(
        [
          "From: Bulk <bulk@example.org>",
          `To: ${email}`,
          "Subject: Bulk",
          `Message-ID: <${id}>`,
          `Date: ${new Date().toUTCString()}`,
          "",
          "x",
          "",
        ].join("\r\n"),
      );
    await client.append("INBOX", bulkMail("bulk1@x"));
    await client.append("INBOX", bulkMail("bulk2@x"));
    await sync();
    const before = await row("bulk1@x");

    await expect(
      provider.bulkArchiveSenderOrThrow(
        "bulk@example.org",
        email,
        emailAccountId,
      ),
    ).resolves.toBe(2);
    await sync();

    const archived = await row("bulk1@x");
    expect(archived.id).toBe(before.id);
    expect(archived.mailbox.role).toBe("archive");
  });

  test.runIf(process.env.IMAP_TEST_LARGE)(
    "a large mailbox stays bounded and reachable",
    async () => {
      const BASELINE = 1000;
      const TOTAL = 1200;
      await client.mailboxCreate("Large");
      for (let index = 0; index < TOTAL; index += 1) {
        await deliver(`large-${index}@x`, {
          folder: "Large",
          subject: `Large ${index}`,
        });
      }

      const baselineStart = Date.now();
      await sync();
      const baselineMs = Date.now() - baselineStart;
      const mailbox = await prisma.imapMailbox.findFirstOrThrow({
        where: { connectionId, path: "Large" },
      });
      await expect(
        prisma.imapMessage.count({ where: { mailboxId: mailbox.id } }),
      ).resolves.toBe(BASELINE);

      const { messages } = await provider.searchMessages({
        query: 'subject:"Large 15"',
        folderId: "Large",
        maxResults: 200,
      });
      expect(messages.map((item) => item.subject)).toContain("Large 150");

      for (let index = 0; index < 600; index += 1) {
        await deliver(`new-${index}@x`, { subject: `Burst ${index}` });
      }
      const calls = newMailCalls();
      const burstStart = Date.now();
      await sync();
      const burstMs = Date.now() - burstStart;
      // Rules run at most 100 messages per run, so a burst drains over several.
      for (let run = 0; run < 6; run += 1) await sync();
      const items = await prisma.imapSyncItem.count({
        where: {
          connectionId,
          messageId: {
            in: (
              await prisma.imapMessage.findMany({
                where: {
                  connectionId,
                  rfc822MessageId: { startsWith: "new-" },
                },
                select: { id: true },
              })
            ).map((message) => message.id),
          },
        },
      });

      const idleStart = Date.now();
      await sync();
      const idleMs = Date.now() - idleStart;

      expect(items).toBe(600);
      expect(newMailCalls() - calls).toBe(600);
      console.log("LARGE", { baselineMs, burstMs, idleMs });
    },
    600_000,
  );

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

  test("an action right after a move to a new folder still applies", async () => {
    await deliver("newfolder@x");
    await sync();
    const before = await row("newfolder@x");

    await provider.moveThreadToFolder(before.threadId, email, "Ganz Neu");
    await provider.markReadThread(before.threadId, true);

    const after = await row("newfolder@x");
    expect(after.mailbox.path).toBe("Ganz Neu");
    expect((await provider.getMessage(before.id)).labelIds).not.toContain(
      "UNREAD",
    );
  });

  test("review mode moves trash and spam to a folder and back", async () => {
    await deliver("review-thread@x");
    await deliver("review-message@x");
    await sync();
    const thread = await row("review-thread@x");
    const message = await row("review-message@x");
    const reviewed = withReviewBeforeDelete(provider, "Zu pruefen", logger);
    const reviewPath = await provider.getOrCreateFolderIdByName("Zu pruefen");

    await reviewed.trashThread(thread.threadId, email, "automation");
    await reviewed.trashMessages([message.id]);

    expect((await row("review-thread@x")).mailbox.path).toBe(reviewPath);
    expect((await row("review-message@x")).mailbox.path).toBe(reviewPath);
    expect((await row("review-thread@x")).id).toBe(thread.id);

    await reviewed.untrashThread(thread.threadId);
    expect((await row("review-thread@x")).mailbox.role).toBe("inbox");

    await reviewed.markSpam(message.threadId);
    expect((await row("review-message@x")).mailbox.path).toBe(reviewPath);
  });

  test("a label query finds labeled mail in any folder and nothing else", async () => {
    await deliver("query-inbox@x", { subject: "Query inbox" });
    await deliver("query-moved@x", { subject: "Query moved" });
    await deliver("query-other@x", { subject: "Query other" });
    await sync();
    const inInbox = await row("query-inbox@x");
    const moved = await row("query-moved@x");
    const label = await provider.createLabel("Abfrage");
    for (const target of [inInbox, moved]) {
      await provider.labelMessage({
        messageId: target.id,
        labelId: label.id,
        labelName: label.name,
      });
    }
    await provider.archiveThread(moved.threadId, email);
    await sync();

    const { threads } = await provider.getThreadsWithQuery({
      query: { labelId: label.id },
    });

    expect(threads.map((thread) => thread.id).toSorted()).toEqual(
      [inInbox.threadId, moved.threadId].toSorted(),
    );

    const inboxOnly = await provider.getThreadsWithQuery({
      query: { labelIds: ["INBOX", label.id] },
    });
    expect(inboxOnly.threads.map((thread) => thread.id)).toEqual([
      inInbox.threadId,
    ]);
  });

  test("thread queries honor type, unread and excluded labels", async () => {
    await deliver("types-read@x", { subject: "Types read" });
    await deliver("types-unread@x", { subject: "Types unread" });
    await deliver("types-excluded@x", { subject: "Types excluded" });
    await sync();
    const read = await row("types-read@x");
    const unread = await row("types-unread@x");
    const excluded = await row("types-excluded@x");
    await provider.markMessagesReadState([read.id], true);
    const label = await provider.createLabel("Bereinigt");
    await provider.labelMessage({
      messageId: excluded.id,
      labelId: label.id,
      labelName: label.name,
    });
    await sync();

    const { threads } = await provider.getThreadsWithQuery({
      query: {
        labelIds: ["INBOX", "UNREAD"],
        excludeLabelNames: ["Bereinigt"],
      },
      maxResults: 50,
    });
    const ids = threads.map((thread) => thread.id);

    expect(ids).toContain(unread.threadId);
    expect(ids).not.toContain(read.threadId);
    expect(ids).not.toContain(excluded.threadId);

    const archive = await provider.getThreadsWithQuery({
      query: { type: "archive" },
      maxResults: 50,
    });
    expect(archive.threads.map((thread) => thread.id)).not.toContain(
      unread.threadId,
    );
  });

  test.each([
    "own",
    "database",
  ] as const)("follow-ups reach only labeled sent mail with %s labels", async (mode) => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await deliver(`followup-sent-${mode}@x`, {
      folder: "Sent",
      date: old,
      subject: `Follow-up sent ${mode}`,
    });
    await deliver(`followup-inbox-${mode}@x`, {
      date: old,
      subject: `Follow-up inbox ${mode}`,
    });
    await sync();
    const sent = await row(`followup-sent-${mode}@x`);
    const untouched = await row(`followup-inbox-${mode}@x`);
    const previous = (await getImapConfig(emailAccountId)).labelStrategy;
    if (mode === "database") {
      await prisma.imapConnection.update({
        where: { id: connectionId },
        data: { labelStrategy: "database" },
      });
    }
    const account = await getImapConfig(emailAccountId);
    const labeled = new ImapProvider(account, logger);
    const label = await labeled.createLabel("Awaiting Reply");
    await labeled.labelMessage({
      messageId: sent.id,
      labelId: label.id,
      labelName: label.name,
    });
    if (mode === "own") await sync();

    await processAccountFollowUps({
      emailAccount: {
        id: emailAccountId,
        email,
        userId,
        followUpAwaitingReplyDays: 1,
        followUpNeedsReplyDays: null,
        followUpAutoDraftEnabled: false,
        timezone: null,
        account: { provider: "imap" },
        user: { aiProvider: null, aiModel: null, aiApiKey: null },
      } as never,
      logger,
    });

    const trackers = await prisma.threadTracker.findMany({
      where: { emailAccountId },
      select: { threadId: true },
    });
    const threadIds = trackers.map((tracker) => tracker.threadId);
    expect(threadIds).toContain(sent.threadId);
    expect(threadIds).not.toContain(untouched.threadId);

    await prisma.threadTracker.deleteMany({ where: { emailAccountId } });
    await prisma.imapConnection.update({
      where: { id: connectionId },
      data: { labelStrategy: previous },
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

  test.skipIf(PLAIN)(
    "a rejected password disconnects the account",
    async () => {
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
    },
  );
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
