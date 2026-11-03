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
import { processAccountFollowUps } from "@/utils/follow-up/process";
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
// Bridge learns of its own sends through events, measured at up to 39 seconds.
const BRIDGE_EVENT_TIMEOUT_MS = 70_000;

vi.setConfig({ testTimeout: 100_000 });

// The QA build restarts its servers every five minutes, see the setup README.
describe.skipIf(!PASSWORD)(
  "IMAP provider against Proton Mail Bridge",
  {
    retry: 1,
  },
  () => {
    const run = randomUUID().slice(0, 8);
    const logger = createTestLogger();
    let userId: string;
    let emailAccountId: string;
    let connectionId: string;
    let provider: ImapProvider;

    const sync = async () => {
      const result = await syncImapAccount({ emailAccountId, logger });
      expect(result.status).toBe("success");
    };
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

    async function deliver(name: string, from = "Ana <ana@example.org>") {
      const subject = `Subject ${name} ${run}`;
      const messageId = await withImap(async (imap) => {
        await imap.append(
          "INBOX",
          Buffer.from(
            [
              `From: ${from}`,
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

      // The Bridge address is fixed, so an interrupted run would block the next.
      await prisma.user.deleteMany({ where: { email: EMAIL } });
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
      await sync();

      const account = await getImapConfig(emailAccountId);
      expect(account.labelStrategy).toBe("folders");
      provider = new ImapProvider(account, logger);

      const mailboxes = await prisma.imapMailbox.findMany({
        where: { connectionId },
        select: { path: true },
      });
      const paths = mailboxes.map(({ path }) => path);
      expect(paths).toEqual(
        expect.arrayContaining(["INBOX", "Sent", "Archive"]),
      );
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
      const created = await provider.getOrCreateFolderIdByName(
        `Projekt ${run}`,
      );
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
        { timeout: BRIDGE_EVENT_TIMEOUT_MS, interval: 2000 },
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
        { timeout: BRIDGE_EVENT_TIMEOUT_MS, interval: 2000 },
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

    test("an action right after a move to a new folder still applies", async () => {
      await deliver("newfolder");
      await sync();
      const before = await row(id("newfolder"));

      await provider.moveThreadToFolder(before.threadId, EMAIL, `Neu ${run}`);
      await provider.markReadThread(before.threadId, true);

      await expect(row(id("newfolder"))).resolves.toMatchObject({
        mailbox: { path: `Folders/Neu ${run}` },
      });
      expect((await provider.getMessage(before.id)).labelIds).not.toContain(
        "UNREAD",
      );
    });

    test("an auto-archive filter applies to new mail and skips rules", async () => {
      const sender = `filter-${run}@example.org`;
      await provider.createAutoArchiveFilter({ from: sender });
      const filters = await provider.getFiltersList();
      const filter = filters.find((item) => item.criteria?.from === sender);
      const calls = newMailCalls();

      await deliver("filtered", sender);
      await sync();

      expect((await row(id("filtered"))).mailbox.role).toBe("archive");
      expect(newMailCalls()).toBe(calls);

      await provider.deleteFilter(filter?.id as string);
    });

    test("bulk sender actions keep IDs after the next sync", async () => {
      const sender = `bulk-${run}@example.org`;
      await deliver("bulk-one", sender);
      await deliver("bulk-two", sender);
      await sync();
      const before = await row(id("bulk-one"));

      await expect(
        provider.bulkArchiveSenderOrThrow(sender, EMAIL, emailAccountId),
      ).resolves.toBe(2);
      await sync();

      await expect(row(id("bulk-one"))).resolves.toMatchObject({
        id: before.id,
        mailbox: { role: "archive" },
      });
    });

    test("a label query returns only labeled threads", async () => {
      await deliver("query-labeled");
      await deliver("query-other");
      await sync();
      const labeled = await row(id("query-labeled"));
      const other = await row(id("query-other"));
      const label = await provider.createLabel(`Abfrage ${run}`);
      await provider.labelMessage({
        messageId: labeled.id,
        labelId: label.id,
        labelName: label.name,
      });
      await syncUntilLabeled(labeled.id, label.id);

      const { threads } = await provider.getThreadsWithQuery({
        query: { labelId: label.id },
      });
      expect(threads.map((thread) => thread.id)).toEqual([labeled.threadId]);

      const inbox = await provider.getThreadsWithQuery({
        query: { labelIds: ["INBOX", label.id] },
      });
      const inboxIds = inbox.threads.map((thread) => thread.id);
      expect(inboxIds).toContain(labeled.threadId);
      expect(inboxIds).not.toContain(other.threadId);
    });

    test("follow-ups reach only labeled mail", async () => {
      await deliver("followup-labeled");
      await deliver("followup-other");
      await sync();
      const labeled = await row(id("followup-labeled"));
      const other = await row(id("followup-other"));
      const label = await provider.createLabel("Awaiting Reply");
      await provider.labelMessage({
        messageId: labeled.id,
        labelId: label.id,
        labelName: label.name,
      });
      await syncUntilLabeled(labeled.id, label.id);

      await processAccountFollowUps({
        emailAccount: {
          id: emailAccountId,
          email: EMAIL,
          userId,
          // Bridge ignores the date given to APPEND, so nothing here looks old.
          followUpAwaitingReplyDays: 0,
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
      // Earlier runs leave labeled mail behind in the same Bridge.
      const trackedThreads = trackers.map((tracker) => tracker.threadId);
      expect(trackedThreads).toContain(labeled.threadId);
      expect(trackedThreads).not.toContain(other.threadId);
      await syncUntilLabeled(labeled.id, "Labels/Follow-up");
      const untouched = await provider.getMessage(other.id);
      expect(untouched.labelIds).not.toContain("Labels/Follow-up");
    });

    test("a read in another client reaches the index", async () => {
      await deliver("remote-read");
      await sync();
      const target = await row(id("remote-read"));

      await withImap(async (imap) => {
        const lock = await imap.getMailboxLock("INBOX");
        await imap.messageFlagsAdd(String(target.uid), ["\\Seen"], {
          uid: true,
        });
        lock.release();
      });
      await sync();

      expect((await provider.getMessage(target.id)).labelIds).not.toContain(
        "UNREAD",
      );
    });
  },
);
