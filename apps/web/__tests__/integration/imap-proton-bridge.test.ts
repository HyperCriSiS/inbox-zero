/**
 * Integration test: IMAP sync and provider against Proton Mail Bridge.
 *
 * Runs the real Bridge against Proton's fake API server, so no Proton account
 * is needed. See docker/proton-bridge-test/README.md for the setup.
 *
 * Usage:
 *   IMAP_BRIDGE_CERT=bridge.crt IMAP_BRIDGE_PASSWORD=<from docker logs> \
 *     IMAP_ALLOW_PRIVATE_HOSTS=true pnpm test-integration imap-proton-bridge
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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

const PASSWORD = process.env.IMAP_BRIDGE_PASSWORD;
const HOST = "127.0.0.1";
const IMAP_PORT = 41_143;
const SMTP_PORT = 41_025;
const EMAIL = "qauser@proton.local";

vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!PASSWORD)("IMAP provider against Proton Mail Bridge", () => {
  const run = randomUUID().slice(0, 8);
  const logger = createTestLogger();
  let userId: string;
  let emailAccountId: string;
  let connectionId: string;
  let provider: ImapProvider;

  const sync = () => syncImapAccount({ emailAccountId, logger });
  // The fake API keeps no external ID, so Bridge reports its own Message-ID.
  const messageIds = new Map<string, string>();
  const id = (name: string) => messageIds.get(name) as string;
  const rows = (rfc822MessageId: string) =>
    prisma.imapMessage.findMany({
      where: { connectionId, rfc822MessageId },
      include: { mailbox: true },
    });
  const row = async (rfc822MessageId: string) => {
    const [first, ...rest] = await rows(rfc822MessageId);
    expect(rest).toEqual([]);
    return first;
  };
  const newMailCalls = () => vi.mocked(processHistoryItem).mock.calls.length;

  // One connection per step, like the app: Bridge can drop idle sessions.
  async function withImap<T>(run: (imap: ImapFlow) => Promise<T>) {
    const imap = new ImapFlow({
      host: HOST,
      port: IMAP_PORT,
      secure: false,
      doSTARTTLS: true,
      tls: { rejectUnauthorized: false },
      auth: { user: EMAIL, pass: PASSWORD as string },
      logger: false,
    });
    imap.on("error", () => undefined);
    await imap.connect();
    try {
      return await run(imap);
    } finally {
      await imap.logout().catch(() => undefined);
    }
  }

  // Bridge can publish a label copy a moment after the COPY returned.
  function syncUntilLabeled(messageId: string, labelId: string) {
    return vi.waitFor(
      async () => {
        await sync();
        const message = await provider.getMessage(messageId);
        expect(message.labelIds).toContain(labelId);
      },
      { timeout: 20_000, interval: 1000 },
    );
  }

  function countIn(path: string, subject: string) {
    return withImap(async (imap) => {
      const lock = await imap.getMailboxLock(path);
      const uids = await imap.search({ subject }, { uid: true });
      lock.release();
      return uids ? uids.length : 0;
    });
  }

  async function deliver(name: string) {
    const subject = `Subject ${name} ${run}`;
    const messageId = await withImap(async (imap) => {
      await imap.append(
        "INBOX",
        Buffer.from(
          [
            "From: Ana <ana@example.org>",
            `To: ${EMAIL}`,
            `Subject: ${subject}`,
            `Message-ID: <${name}-${run}@x>`,
            `Date: ${new Date().toUTCString()}`,
            "Content-Type: text/plain; charset=utf-8",
            "",
            `Body of ${name}`,
            "",
          ].join("\r\n"),
        ),
      );

      const lock = await imap.getMailboxLock("INBOX");
      const [uid] = (await imap.search({ subject }, { uid: true })) || [];
      const message = await imap.fetchOne(
        String(uid),
        { envelope: true },
        { uid: true },
      );
      lock.release();
      return message ? message.envelope?.messageId : undefined;
    });
    messageIds.set(name, (messageId as string).replace(/[<>]/g, ""));
  }

  beforeAll(async () => {
    const pinnedCert = readFileSync(
      process.env.IMAP_BRIDGE_CERT as string,
      "utf8",
    );
    await deliver("old");

    const user = await prisma.user.create({ data: { email: EMAIL } });
    userId = user.id;
    const account = await prisma.account.create({
      data: {
        userId,
        provider: "imap",
        providerAccountId: EMAIL,
        type: "credential",
      },
    });
    const emailAccount = await prisma.emailAccount.create({
      data: { email: EMAIL, userId, accountId: account.id },
    });
    emailAccountId = emailAccount.id;
    const connection = await prisma.imapConnection.create({
      data: {
        emailAccountId,
        imapHost: HOST,
        imapPort: IMAP_PORT,
        imapSecurity: "starttls",
        tlsPinnedCertPem: pinnedCert,
        smtpHost: HOST,
        smtpPort: SMTP_PORT,
        smtpSecurity: "starttls",
        username: EMAIL,
        password: PASSWORD as string,
      },
    });
    connectionId = connection.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  test("baseline finds the labels root and skips virtual folders", async () => {
    const result = await sync();

    expect(result.status).toBe("success");
    const account = await getImapConfig(emailAccountId);
    expect(account.labelStrategy).toBe("folders");
    provider = new ImapProvider(account, logger);

    const mailboxes = await prisma.imapMailbox.findMany({
      where: { connectionId },
      select: { path: true },
    });
    const paths = mailboxes.map(({ path }) => path);
    expect(paths).toEqual(expect.arrayContaining(["INBOX", "Sent", "Archive"]));
    for (const path of ["All Mail", "Starred", "Labels", "Folders"]) {
      expect(paths).not.toContain(path);
    }
    await expect(row(id("old"))).resolves.toMatchObject({
      mailbox: { role: "inbox" },
    });
  });

  test("new mail runs rules once", async () => {
    await deliver("new");

    await sync();
    await sync();

    expect(newMailCalls()).toBe(1);
    await expect(row(id("new"))).resolves.toBeTruthy();
  });

  test("a label reaches Proton, survives a sync and can be removed", async () => {
    await deliver("label");
    await sync();
    const target = await row(id("label"));
    const calls = newMailCalls();

    const name = `Rechnungen ${run}`;
    const label = await provider.createLabel(name);
    await expect(provider.createLabel(name)).resolves.toMatchObject({
      id: label.id,
    });
    await provider.labelMessage({
      messageId: target.id,
      labelId: label.id,
      labelName: label.name,
    });
    await syncUntilLabeled(target.id, label.id);

    expect(label.id).toBe(`Labels/${name}`);
    const labeled = await provider.getMessage(target.id);
    expect(labeled.labelIds).toContain("INBOX");
    expect(newMailCalls()).toBe(calls);
    await expect(provider.getLabelByName(name)).resolves.toMatchObject({
      id: label.id,
    });

    await provider.removeThreadLabel(target.threadId, label.id);
    await sync();

    const unlabeled = await provider.getMessage(target.id);
    expect(unlabeled.labelIds).toContain("INBOX");
    expect(unlabeled.labelIds).not.toContain(label.id);
  });

  test("Inbox Zero's own nested label names work", async () => {
    await deliver("system-label");
    await sync();
    const target = await row(id("system-label"));

    const label = await provider.getOrCreateInboxZeroLabel("processed");
    expect(label.id).toBe("Labels/Inbox Zero - Processed");
    await provider.labelMessage({
      messageId: target.id,
      labelId: label.id,
      labelName: label.name,
    });
    await syncUntilLabeled(target.id, label.id);

    await expect(
      provider.getOrCreateInboxZeroLabel("processed"),
    ).resolves.toMatchObject({ id: label.id });
  });

  test("custom folders live under Folders and can be renamed", async () => {
    const created = await provider.getOrCreateFolderIdByName(`Projekt ${run}`);
    expect(created).toBe(`Folders/Projekt ${run}`);
    await expect(
      provider.getOrCreateFolderIdByName(`Projekt ${run}`),
    ).resolves.toBe(created);

    await provider.renameFolder(created, `Umbenannt ${run}`);
    await sync();

    const folders = await provider.getFolders();
    expect(folders.map((folder) => folder.id)).toContain(
      `Folders/Umbenannt ${run}`,
    );
    await provider.deleteFolder(`Folders/Umbenannt ${run}`);
  });

  test("archiving moves the message and keeps its ID", async () => {
    await deliver("archive");
    await sync();
    const before = await row(id("archive"));

    await provider.archiveThread(before.threadId, EMAIL);
    await sync();

    const after = await row(id("archive"));
    expect(after.id).toBe(before.id);
    expect(after.mailbox.role).toBe("archive");

    await provider.unarchiveThread(before.threadId);
    await sync();
    expect((await row(id("archive"))).mailbox.role).toBe("inbox");
  });

  test("read state set here stays set after a sync", async () => {
    await deliver("read");
    await sync();
    const target = await row(id("read"));

    await provider.markMessagesReadState([target.id], true);
    await sync();

    expect((await provider.getMessage(target.id)).labelIds).not.toContain(
      "UNREAD",
    );
  });

  test("sent mail ends up in Sent exactly once", async () => {
    const { messageId } = await provider.sendEmailWithHtml({
      to: "Bob <bob@example.org>",
      subject: `Sent ${run}`,
      messageHtml: "<p>Hi</p>",
    });

    await vi.waitFor(
      async () => {
        await sync();
        await expect(
          rows(messageId.replace(/[<>]/g, "")),
        ).resolves.toHaveLength(1);
      },
      { timeout: 40_000, interval: 2000 },
    );
    await expect(countIn("Sent", `Sent ${run}`)).resolves.toBe(1);
  });

  test("draft edits keep the draft ID and deleting removes it", async () => {
    const { id: draftId } = await provider.createDraft({
      to: "bob@example.org",
      subject: `Draft ${run}`,
      messageHtml: "<p>One</p>",
    });
    await provider.updateDraft(draftId, { messageHtml: "<p>Two</p>" });
    await sync();

    const draft = await provider.getDraft(draftId);
    expect(draft?.textHtml).toContain("Two");

    await provider.deleteDraft(draftId);
    await sync();
    await expect(provider.getDraft(draftId)).resolves.toBeNull();
  });

  test("a sent draft leaves Drafts and arrives in Sent once", async () => {
    const { id: draftId } = await provider.createDraft({
      to: "bob@example.org",
      subject: `Sent draft ${run}`,
      messageHtml: "<p>Body</p>",
    });

    await provider.sendDraft(draftId);

    const subject = `Sent draft ${run}`;
    await vi.waitFor(
      async () => {
        expect(await countIn("Sent", subject)).toBe(1);
        expect(await countIn("Drafts", subject)).toBe(0);
      },
      { timeout: 40_000, interval: 2000 },
    );
  });

  test("a labeled message shows once in lists and threads", async () => {
    await deliver("listed");
    await sync();
    const target = await row(id("listed"));
    const label = await provider.createLabel(`Liste ${run}`);
    await provider.labelMessage({
      messageId: target.id,
      labelId: label.id,
      labelName: label.name,
    });
    await syncUntilLabeled(target.id, label.id);

    const thread = await provider.getThread(target.threadId);
    expect(thread.messages.map((message) => message.id)).toEqual([target.id]);
    const { messages } = await provider.getMessagesWithPagination({
      maxResults: 100,
    });
    expect(messages.filter((item) => item.id === target.id)).toHaveLength(1);
  });

  test("trash, spam and custom folders move the message", async () => {
    await deliver("move");
    await sync();
    const before = await row(id("move"));
    const role = async () =>
      (
        await prisma.imapMessage.findUniqueOrThrow({
          where: { id: before.id },
          include: { mailbox: true },
        })
      ).mailbox;

    await provider.trashThread(before.threadId, EMAIL, "user");
    await sync();
    expect((await role()).role).toBe("trash");

    await provider.untrashThread(before.threadId);
    await sync();
    expect((await role()).role).toBe("inbox");

    await provider.markSpam(before.threadId);
    await sync();
    expect((await role()).role).toBe("junk");

    await provider.markNotSpam(before.threadId);
    await sync();

    await provider.moveThreadToFolder(before.threadId, EMAIL, `Ziel ${run}`);
    await sync();
    expect((await role()).path).toBe(`Folders/Ziel ${run}`);
  });

  test("folder counts cover custom folders and labels", async () => {
    const counts = await provider.getFolderCounts();

    expect(
      counts.find((folder) => folder.id === "INBOX")?.total,
    ).toBeGreaterThan(0);
    expect(
      counts.find((folder) => folder.id === `Labels/Liste ${run}`)?.total,
    ).toBe(1);
  });

  test("a read in another client reaches the index", async () => {
    await deliver("remote-read");
    await sync();
    const target = await row(id("remote-read"));

    await withImap(async (imap) => {
      const lock = await imap.getMailboxLock("INBOX");
      await imap.messageFlagsAdd(String(target.uid), ["\\Seen"], { uid: true });
      lock.release();
    });
    await sync();

    expect((await provider.getMessage(target.id)).labelIds).not.toContain(
      "UNREAD",
    );
  });
});
