import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { DraftNotFoundError } from "@/utils/error";
import type { ImapAccount } from "@/utils/imap/config";
import { ImapProvider } from "./imap";

vi.mock("@/utils/prisma");

const { client, sendRawMessageMock } = vi.hoisted(() => ({
  client: {
    mailbox: undefined as { path: string; uidValidity: bigint } | undefined,
    capabilities: new Map<string, boolean>(),
    getMailboxLock: vi.fn(),
    append: vi.fn(),
    fetch: vi.fn(),
    fetchOne: vi.fn(),
    list: vi.fn(),
    mailboxCreate: vi.fn(),
    mailboxDelete: vi.fn(),
    mailboxRename: vi.fn(),
    messageCopy: vi.fn(),
    messageDelete: vi.fn(),
    messageFlagsAdd: vi.fn(),
    messageFlagsRemove: vi.fn(),
    messageMove: vi.fn(),
    search: vi.fn(),
    status: vi.fn(),
  },
  sendRawMessageMock: vi.fn(),
}));

vi.mock("@/utils/imap/connection", () => ({
  withImapClient: (
    _config: unknown,
    _logger: unknown,
    run: (imap: typeof client) => unknown,
  ) => run(client),
}));

vi.mock("@/utils/imap/smtp", async () => ({
  ...(await vi.importActual<typeof import("@/utils/imap/smtp")>(
    "@/utils/imap/smtp",
  )),
  sendRawMessage: sendRawMessageMock,
}));

const UID_VALIDITY = BigInt(7);
const MAILBOXES = {
  inbox: mailbox("inbox", "INBOX"),
  sent: mailbox("sent", "Sent"),
  drafts: mailbox("drafts", "Drafts"),
  trash: mailbox("trash", "Trash"),
  junk: mailbox("junk", "Junk"),
  archive: mailbox("archive", "Archive"),
};

beforeEach(() => {
  vi.clearAllMocks();
  client.mailbox = undefined;
  client.capabilities = new Map([
    ["UIDPLUS", true],
    ["MOVE", true],
  ]);
  client.getMailboxLock.mockImplementation(async (path: string) => {
    client.mailbox = { path, uidValidity: UID_VALIDITY };
    return { release: vi.fn() };
  });
  client.messageMove.mockResolvedValue({ uidMap: new Map() });
  client.messageDelete.mockResolvedValue(true);
  client.messageFlagsAdd.mockResolvedValue(true);
  client.messageFlagsRemove.mockResolvedValue(true);
  client.messageCopy.mockResolvedValue({ uidMap: new Map() });
  client.append.mockResolvedValue({ uid: 99, uidValidity: UID_VALIDITY });
  client.search.mockResolvedValue([]);
  prisma.imapMailbox.findFirst.mockImplementation(((args: {
    where: { role: keyof typeof MAILBOXES };
  }) => Promise.resolve(MAILBOXES[args.where.role] ?? null)) as never);
});

describe("ImapProvider drafts", () => {
  it("refuses to rewrite a received message passed as a draft ID", async () => {
    mockRows([row("m1", "inbox", 1)]);

    await expect(
      provider().updateDraft("m1", { messageHtml: "<p>changed</p>" }),
    ).rejects.toBeInstanceOf(DraftNotFoundError);

    expect(client.append).not.toHaveBeenCalled();
    expect(client.messageDelete).not.toHaveBeenCalled();
  });

  it("refuses to send a received message passed as a draft ID", async () => {
    mockRows([row("m1", "inbox", 1)]);

    await expect(provider().sendDraft("m1")).rejects.toBeInstanceOf(
      DraftNotFoundError,
    );

    expect(sendRawMessageMock).not.toHaveBeenCalled();
  });

  it("does not report a received message as a draft", async () => {
    mockRows([row("m1", "inbox", 1)]);

    expect(await provider().getDraft("m1")).toBeNull();
  });
});

describe("ImapProvider sender actions", () => {
  it("only moves mail whose From address is exactly the sender", async () => {
    // IMAP SEARCH FROM is a substring match, so the server returns all four.
    client.search.mockResolvedValue([1, 2, 3, 4]);
    mockEnvelopes({
      1: "bob@example.com",
      2: "notbob@example.com",
      3: "someone@other.org",
      4: "bob@example.com.evil.test",
    });

    await provider().bulkTrashFromSenders(["Bob@Example.com"], "me", "a");

    expect(client.messageMove).toHaveBeenCalledTimes(1);
    expect(client.messageMove).toHaveBeenCalledWith("1", "Trash", {
      uid: true,
    });
  });

  it("fails when the server refuses the move", async () => {
    client.search.mockResolvedValue([1]);
    mockEnvelopes({ 1: "bob@example.com" });
    client.messageMove.mockResolvedValue(false);

    await expect(
      provider().bulkArchiveSenderOrThrow("bob@example.com", "me", "a"),
    ).rejects.toThrow("IMAP move failed");
  });

  it("does not count mail from a longer address as received mail", async () => {
    client.search.mockResolvedValue([1, 2]);
    mockEnvelopes({ 1: "notbob@example.com", 2: "bob@example.com" });

    expect(await provider().countReceivedMessages("bob@example.com", 5)).toBe(
      1,
    );
  });
});

describe("ImapProvider thread actions", () => {
  const thread = () =>
    mockRows([
      row("received", "inbox", 1),
      row("reply", "sent", 2),
      row("draft", "drafts", 3),
      row("old", "trash", 4),
    ]);

  it("archives only what is in the inbox", async () => {
    thread();

    await provider().archiveThread("thread-1", "me@example.com");

    expect(moves()).toEqual([["INBOX", "1", "Archive"]]);
  });

  it("trashes a thread without its sent copies and drafts", async () => {
    thread();

    await provider().trashThread("thread-1", "me@example.com", "user");

    expect(moves()).toEqual([["INBOX", "1", "Trash"]]);
  });

  it("restores only what is in the trash", async () => {
    thread();

    await provider().untrashThread("thread-1");

    expect(moves()).toEqual([["Trash", "4", "INBOX"]]);
  });
});

describe("ImapProvider writes", () => {
  it("refuses to act when the folder's UIDs were reassigned", async () => {
    mockRows([row("m1", "inbox", 1)]);
    client.getMailboxLock.mockImplementation(async (path: string) => {
      client.mailbox = { path, uidValidity: UID_VALIDITY + BigInt(1) };
      return { release: vi.fn() };
    });

    await expect(provider().trashMessages(["m1"])).rejects.toThrow(
      "changed on the mail server",
    );
    expect(client.messageMove).not.toHaveBeenCalled();
  });

  it("refuses to act on a row the sync has not relinked yet", async () => {
    mockRows([{ ...row("m1", "inbox", 1), uidValidity: BigInt(1) }]);

    await expect(
      provider().markMessagesReadState(["m1"], true),
    ).rejects.toThrow("changed on the mail server");
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it("fails when the server does not store a flag", async () => {
    mockRows([row("m1", "inbox", 1)]);
    client.messageFlagsAdd.mockResolvedValue(false);

    await expect(
      provider().markMessagesReadState(["m1"], true),
    ).rejects.toThrow("IMAP flag change failed");
  });

  it("does not expunge other clients' deletions on servers without UIDPLUS", async () => {
    mockRows([row("d1", "drafts", 3)]);
    client.capabilities = new Map();
    client.search.mockResolvedValue([8]);

    await expect(provider().deleteDraft("d1")).rejects.toThrow(
      "marked for deletion",
    );
    expect(client.messageDelete).not.toHaveBeenCalled();
    expect(prisma.imapMessage.delete).not.toHaveBeenCalled();
  });
});

describe("ImapProvider labels and folders", () => {
  it("refuses to delete a folder that is not a label folder as a label", async () => {
    await expect(
      provider("folders").deleteLabel("Projects/Taxes"),
    ).rejects.toThrow("not a label");
    expect(client.mailboxDelete).not.toHaveBeenCalled();
  });

  it("refuses to remove a label by deleting mail outside label folders", async () => {
    mockRows([row("m1", "inbox", 1)]);

    await expect(
      provider("folders").removeThreadLabel("thread-1", "INBOX"),
    ).rejects.toThrow("not a label");
    expect(client.messageDelete).not.toHaveBeenCalled();
  });

  it("moves a folder's mail to the trash before deleting the folder", async () => {
    prisma.imapMailbox.findUnique.mockResolvedValue({ role: null } as never);
    client.getMailboxLock.mockImplementation(async (path: string) => {
      client.mailbox = { path, uidValidity: UID_VALIDITY, exists: 3 } as never;
      return { release: vi.fn() };
    });

    await provider().deleteFolder("Projects");

    expect(client.messageMove).toHaveBeenCalledWith("1:*", "Trash", {
      uid: true,
    });
    expect(client.messageMove.mock.invocationCallOrder[0]).toBeLessThan(
      client.mailboxDelete.mock.invocationCallOrder[0],
    );
  });

  it("refuses to delete a system folder", async () => {
    prisma.imapMailbox.findUnique.mockResolvedValue({ role: "sent" } as never);

    await expect(provider().deleteFolder("Sent")).rejects.toThrow(
      "cannot be deleted",
    );
    expect(client.mailboxDelete).not.toHaveBeenCalled();
  });
});

describe("ImapProvider on servers that compare dates only", () => {
  beforeEach(() => {
    client.capabilities = new Map([["UIDPLUS", true]]);
  });

  it("does not take the checked message itself for prior contact", async () => {
    mockRows([row("m1", "inbox", 5)]);
    client.search.mockImplementation(async () =>
      client.mailbox?.path === "INBOX" ? [5] : [],
    );
    mockEnvelopes({ 5: "stranger@gmail.com" });

    expect(
      await provider().hasPreviousCommunicationsWithSenderOrDomain({
        from: "stranger@gmail.com",
        date: new Date("2026-11-08T12:00:00Z"),
        messageId: "m1",
      }),
    ).toBe(false);
  });

  it("leaves mail from later on the cursor day out of a page", async () => {
    const before = new Date("2026-11-08T12:00:00Z");
    prisma.imapMailbox.findUniqueOrThrow.mockResolvedValue({
      ...MAILBOXES.inbox,
      lastSeenUid: BigInt(10),
    } as never);
    mockRows([row("older", "sent", 3), row("early", "sent", 1)]);
    client.search.mockImplementation(async (criteria: { since?: Date }) =>
      criteria.since ? [1, 2] : [1, 2, 3],
    );
    client.fetch.mockImplementation(async function* (range: string) {
      const dates: Record<number, string> = {
        1: "2026-11-08T08:00:00Z",
        2: "2026-11-08T16:00:00Z",
      };
      for (const uid of range.split(",").map(Number)) {
        yield { uid, internalDate: new Date(dates[uid]) };
      }
    });

    await provider().getSentMessageIds({ maxResults: 10, before });

    expect(prisma.imapMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ uid: { in: [BigInt(3), BigInt(1)] } }),
      }),
    );
  });
});

function moves() {
  return client.messageMove.mock.calls.map(([uids, target], index) => [
    client.getMailboxLock.mock.calls[index][0],
    uids,
    target,
  ]);
}

function mockEnvelopes(fromByUid: Record<number, string>) {
  client.fetch.mockImplementation(async function* (range: string) {
    for (const uid of range.split(",").map(Number)) {
      yield { uid, envelope: { from: [{ address: fromByUid[uid] }] } };
    }
  });
}

function provider(labelStrategy: ImapAccount["labelStrategy"] = "database") {
  return new ImapProvider(
    {
      emailAccountId: "account-1",
      connectionId: "connection-1",
      email: "me@example.com",
      labelStrategy,
    } as ImapAccount,
    createTestLogger(),
  );
}

function mailbox(role: string | null, path: string) {
  return { id: `mailbox-${path}`, path, role, uidValidity: UID_VALIDITY };
}

function row(id: string, role: keyof typeof MAILBOXES, uid: number) {
  return {
    id,
    labels: [],
    mailbox: MAILBOXES[role],
    mailboxId: MAILBOXES[role].id,
    rfc822MessageId: `${id}@example.com`,
    threadId: "thread-1",
    uid: BigInt(uid),
    uidValidity: UID_VALIDITY,
  };
}

function mockRows(rows: ReturnType<typeof row>[]) {
  prisma.imapMessage.findMany.mockResolvedValue(rows as never);
}
