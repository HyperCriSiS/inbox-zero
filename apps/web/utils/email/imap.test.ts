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
