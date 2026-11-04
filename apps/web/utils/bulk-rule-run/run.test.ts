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
  pageToken: null,
};

function thread(id: string) {
  return { id, messages: [{ id: `${id}-m`, threadId: id }] };
}

let provider: EmailProvider;

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
  prisma.bulkRuleRun.update.mockResolvedValue({ status: "RUNNING" } as never);
});

describe("processBulkRuleRunSlice", () => {
  it("runs rules on new threads, skips done ones and completes", async () => {
    prisma.bulkRuleRun.findUnique.mockResolvedValue(baseRun as never);
    prisma.executedRule.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "done" } as never);
    vi.mocked(provider.getThreadsWithQuery).mockResolvedValue({
      threads: [thread("a"), thread("b")] as never,
    });

    await expect(
      processBulkRuleRunSlice({ runId: "run-1", logger }),
    ).resolves.toBe("completed");

    expect(runRules).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(provider.getThreadsWithQuery).mock.calls[0][0],
    ).toMatchObject({ query: { type: "inbox", isUnread: true } });
    expect(prisma.bulkRuleRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processed: { increment: 1 },
          skipped: { increment: 1 },
        }),
      }),
    );
    expect(prisma.bulkRuleRun.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
  });

  it("counts a failing message and keeps going", async () => {
    prisma.bulkRuleRun.findUnique.mockResolvedValue(baseRun as never);
    vi.mocked(runRules)
      .mockRejectedValueOnce(new Error("AI down"))
      .mockResolvedValueOnce([]);
    vi.mocked(provider.getThreadsWithQuery).mockResolvedValue({
      threads: [thread("a"), thread("b")] as never,
    });

    await processBulkRuleRunSlice({ runId: "run-1", logger });

    expect(runRules).toHaveBeenCalledTimes(2);
    expect(prisma.bulkRuleRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processed: { increment: 1 },
          failed: { increment: 1 },
        }),
      }),
    );
  });

  it("stops after the page when the run was paused meanwhile", async () => {
    prisma.bulkRuleRun.findUnique.mockResolvedValue(baseRun as never);
    prisma.bulkRuleRun.update.mockResolvedValue({ status: "PAUSED" } as never);
    vi.mocked(provider.getThreadsWithQuery).mockResolvedValue({
      threads: [thread("a")] as never,
      nextPageToken: "next",
    });

    await expect(
      processBulkRuleRunSlice({ runId: "run-1", logger }),
    ).resolves.toBe("idle");
    expect(provider.getThreadsWithQuery).toHaveBeenCalledTimes(1);
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("does nothing for a run that is not running", async () => {
    prisma.bulkRuleRun.findUnique.mockResolvedValue({
      ...baseRun,
      status: "CANCELLED",
    } as never);

    await expect(
      processBulkRuleRunSlice({ runId: "run-1", logger }),
    ).resolves.toBe("idle");
    expect(createEmailProvider).not.toHaveBeenCalled();
  });

  it("resumes from the saved page token and reruns when asked", async () => {
    prisma.bulkRuleRun.findUnique.mockResolvedValue({
      ...baseRun,
      pageToken: "saved",
      rerun: true,
      includeRead: true,
    } as never);
    prisma.executedRule.findFirst.mockResolvedValue({ id: "done" } as never);
    vi.mocked(provider.getThreadsWithQuery).mockResolvedValue({
      threads: [thread("a")] as never,
    });

    await processBulkRuleRunSlice({ runId: "run-1", logger });

    const call = vi.mocked(provider.getThreadsWithQuery).mock.calls[0][0];
    expect(call.pageToken).toBe("saved");
    expect(call.query).not.toHaveProperty("isUnread");
    expect(runRules).toHaveBeenCalledTimes(1);
  });
});
