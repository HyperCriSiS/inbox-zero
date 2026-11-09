import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createMockEmailProvider } from "@/utils/__mocks__/email-provider";
import { createTestLogger } from "@/__tests__/helpers";
import { runRules } from "@/utils/ai/choose-rule/run-rules";
import { createEmailProvider } from "@/utils/email/provider";
import type { EmailProvider } from "@/utils/email/types";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";
import { getEmailAccountForRuleExecution } from "@/utils/user/get";
import { processBulkRuleRunSlice } from "./run";

vi.mock("@/utils/prisma");
vi.mock("@/utils/ai/choose-rule/run-rules", () => ({ runRules: vi.fn() }));
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/utils/queue/dispatch", () => ({ enqueueBackgroundJob: vi.fn() }));
vi.mock("@/utils/user/get", () => ({
  getEmailAccountForRuleExecution: vi.fn(),
}));

const logger = createTestLogger();
const baseRun = {
  id: "run-1",
  emailAccountId: "account-1",
  status: "RUNNING",
  startDate: new Date("2026-01-01"),
  endDate: null,
  includeRead: false,
  rerun: false,
  skipDraftReplies: true,
  cursorBefore: null,
};
const day = (n: number) =>
  String(new Date(`2026-03-${String(n).padStart(2, "0")}T10:00:00Z`).getTime());
function thread(id: string, date: string) {
  return {
    id,
    messages: [{ id: `${id}-m`, threadId: id, internalDate: date }],
  };
}

let provider: EmailProvider;
let owner: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  provider = createMockEmailProvider();
  vi.mocked(createEmailProvider).mockResolvedValue(provider);
  vi.mocked(getEmailAccountForRuleExecution).mockResolvedValue({
    id: "account-1",
    account: { provider: "imap" },
  } as never);
  prisma.rule.findMany.mockResolvedValue([]);
  prisma.executedRule.findFirst.mockResolvedValue(null);
  prisma.bulkRuleRun.findUniqueOrThrow.mockResolvedValue(baseRun as never);
  // Capture the lease owner the slice claims with.
  prisma.bulkRuleRun.updateMany.mockImplementation((async (args: {
    data: { leaseOwner?: string };
  }) => {
    if (args.data.leaseOwner) owner = args.data.leaseOwner;
    return { count: 1 };
  }) as never);
  prisma.bulkRuleRun.update.mockImplementation((async () => ({
    status: "RUNNING",
    leaseOwner: owner,
  })) as never);
  prisma.bulkRuleRun.findUnique.mockResolvedValue({
    status: "RUNNING",
  } as never);
});

function pages(...threadPages: ReturnType<typeof thread>[][]) {
  const mock = vi.mocked(provider.getThreadsWithQuery);
  for (const threads of threadPages) {
    mock.mockResolvedValueOnce({ threads } as never);
  }
  mock.mockResolvedValue({ threads: [] } as never);
}

describe("processBulkRuleRunSlice", () => {
  it("does nothing while another slice holds the lease", async () => {
    prisma.bulkRuleRun.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      processBulkRuleRunSlice({ runId: "run-1", logger }),
    ).resolves.toBe("idle");
    expect(createEmailProvider).not.toHaveBeenCalled();
  });

  it("walks back by date, skips done threads and completes", async () => {
    pages([thread("a", day(5)), thread("b", day(4))], [thread("c", day(2))]);
    prisma.executedRule.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "done" } as never);

    await expect(
      processBulkRuleRunSlice({ runId: "run-1", logger }),
    ).resolves.toBe("completed");

    const calls = vi.mocked(provider.getThreadsWithQuery).mock.calls;
    expect(calls[0][0].query).toMatchObject({ type: "inbox", isUnread: true });
    expect(calls[0][0].query).not.toHaveProperty("before");
    // The next page starts below the oldest thread seen, not at an offset.
    expect(calls[1][0].query?.before).toEqual(new Date(Number(day(4))));
    expect(runRules).toHaveBeenCalledTimes(2);
    expect(prisma.bulkRuleRun.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
  });

  it("counts a failing message and keeps going", async () => {
    pages([thread("a", day(5)), thread("b", day(4))]);
    vi.mocked(runRules)
      .mockRejectedValueOnce(new Error("AI down"))
      .mockResolvedValueOnce([]);

    await processBulkRuleRunSlice({ runId: "run-1", logger });

    expect(prisma.bulkRuleRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processed: { increment: 1 },
          failed: { increment: 1 },
        }),
      }),
    );
  });

  it("stops after the page when paused and queues nothing", async () => {
    pages([thread("a", day(5))], [thread("b", day(4))]);
    prisma.bulkRuleRun.update.mockResolvedValueOnce({
      status: "PAUSED",
      leaseOwner: "x",
    } as never);
    prisma.bulkRuleRun.findUnique.mockResolvedValue({
      status: "PAUSED",
    } as never);

    await expect(
      processBulkRuleRunSlice({ runId: "run-1", logger }),
    ).resolves.toBe("idle");
    expect(provider.getThreadsWithQuery).toHaveBeenCalledTimes(1);
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("queues the next slice when resumed while it was stopping", async () => {
    pages([thread("a", day(5))], [thread("b", day(4))]);
    prisma.bulkRuleRun.update.mockResolvedValueOnce({
      status: "PAUSED",
      leaseOwner: "x",
    } as never);
    // The resume landed between the page and the lease release.
    prisma.bulkRuleRun.findUnique.mockResolvedValue({
      status: "RUNNING",
    } as never);

    await processBulkRuleRunSlice({ runId: "run-1", logger });

    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
  });

  it("marks the run failed when the mailbox cannot be read", async () => {
    vi.mocked(provider.getThreadsWithQuery).mockRejectedValue(
      new Error("IMAP down"),
    );

    await expect(
      processBulkRuleRunSlice({ runId: "run-1", logger }),
    ).resolves.toBe("failed");
    expect(prisma.bulkRuleRun.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", leaseOwner: null }),
      }),
    );
  });

  it("resumes below the saved cursor and reruns when asked", async () => {
    prisma.bulkRuleRun.findUniqueOrThrow.mockResolvedValue({
      ...baseRun,
      cursorBefore: new Date(Number(day(9))),
      rerun: true,
      includeRead: true,
    } as never);
    prisma.executedRule.findFirst.mockResolvedValue({ id: "done" } as never);
    pages([thread("a", day(8))]);

    await processBulkRuleRunSlice({ runId: "run-1", logger });

    const query = vi.mocked(provider.getThreadsWithQuery).mock.calls[0][0]
      .query;
    expect(query?.before).toEqual(new Date(Number(day(9))));
    expect(query).not.toHaveProperty("isUnread");
    expect(runRules).toHaveBeenCalledTimes(1);
  });
});
