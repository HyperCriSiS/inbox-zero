import { randomUUID } from "node:crypto";
import { addDays } from "date-fns/addDays";
import { startOfDay } from "date-fns/startOfDay";
import { BulkRuleRunStatus } from "@/generated/prisma/enums";
import { runRules } from "@/utils/ai/choose-rule/run-rules";
import { internalDateToDate } from "@/utils/date";
import { createEmailProvider } from "@/utils/email/provider";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";
import { getEmailAccountForRuleExecution } from "@/utils/user/get";

const BULK_RULE_RUN_QUEUE = "bulk-rule-run";
const PAGE_SIZE = 25;
// Below the route's maxDuration, so a slice always saves its place.
const SLICE_BUDGET_MS = 4 * 60 * 1000;
// Longer than one page takes, so only a crashed slice loses its lease.
const LEASE_MS = 10 * 60 * 1000;

export type BulkRuleRunBody = { runId: string };

export async function enqueueBulkRuleRun(runId: string, logger: Logger) {
  await enqueueBackgroundJob<BulkRuleRunBody>({
    topic: BULK_RULE_RUN_QUEUE,
    body: { runId },
    qstash: {
      queueName: BULK_RULE_RUN_QUEUE,
      parallelism: 3,
      path: "/api/bulk-rule-run",
    },
    logger,
  });
}

/**
 * Processes one slice of a run: walks the inbox from newest to oldest and runs
 * the rules on the newest message of each thread, like the browser-driven bulk
 * run. Only the slice holding the lease works on a run, so a quick pause and
 * resume cannot start a second one. Progress is saved after every page as a
 * date cursor, which rules that archive or mark mail read cannot shift. When
 * time is up the next slice is queued.
 */
export async function processBulkRuleRunSlice({
  runId,
  logger,
}: {
  runId: string;
  logger: Logger;
}) {
  const owner = randomUUID();
  const claimed = await prisma.bulkRuleRun.updateMany({
    where: {
      id: runId,
      status: BulkRuleRunStatus.RUNNING,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    },
    data: { leaseOwner: owner, leaseUntil: new Date(Date.now() + LEASE_MS) },
  });
  // Paused, finished, or another slice is on it and will continue.
  if (!claimed.count) return "idle";

  const run = await prisma.bulkRuleRun.findUniqueOrThrow({
    where: { id: runId },
  });
  const log = logger.with({ runId, emailAccountId: run.emailAccountId });

  try {
    const outcome = await processPages({ run, owner, log });
    if (outcome === "continue") {
      await release(runId, owner);
      await enqueueBulkRuleRun(runId, log);
      return "continued";
    }
    if (outcome === "done") {
      await finish(runId, BulkRuleRunStatus.COMPLETED);
      return "completed";
    }
    // Paused or stopped meanwhile. A resume that came in before the release
    // found the lease taken, so this slice queues the next one.
    const released = await release(runId, owner);
    if (released?.status === BulkRuleRunStatus.RUNNING) {
      await enqueueBulkRuleRun(runId, log);
    }
    return "idle";
  } catch (error) {
    log.error("Bulk run failed", { error });
    await finish(
      runId,
      BulkRuleRunStatus.FAILED,
      "The run stopped on an error",
    );
    return "failed";
  }
}

async function processPages({
  run,
  owner,
  log,
}: {
  run: Awaited<ReturnType<typeof prisma.bulkRuleRun.findUniqueOrThrow>>;
  owner: string;
  log: Logger;
}): Promise<"continue" | "done" | "stopped"> {
  const emailAccount = await getEmailAccountForRuleExecution({
    emailAccountId: run.emailAccountId,
  });
  if (!emailAccount) throw new Error("Email account not found");

  const provider = await createEmailProvider({
    emailAccountId: run.emailAccountId,
    provider: emailAccount.account.provider,
    logger: log,
  });
  const rules = await prisma.rule.findMany({
    where: { emailAccountId: run.emailAccountId, enabled: true },
    include: { actions: true },
  });

  // Provider "before" filters are exclusive; the selected day is inclusive.
  const endBefore = run.endDate
    ? startOfDay(addDays(run.endDate, 1))
    : undefined;
  let cursor = run.cursorBefore ?? endBefore;
  const started = Date.now();

  while (Date.now() - started < SLICE_BUDGET_MS) {
    const { threads } = await provider.getThreadsWithQuery({
      query: {
        type: "inbox",
        after: run.startDate,
        ...(cursor ? { before: cursor } : {}),
        ...(run.includeRead ? {} : { isUnread: true }),
      },
      maxResults: PAGE_SIZE,
    });

    const counts = { processed: 0, skipped: 0, failed: 0 };
    let oldest: Date | undefined;
    for (const thread of threads) {
      const message = thread.messages?.at(-1);
      if (!message) continue;
      const date = internalDateToDate(message.internalDate);
      if (!oldest || date < oldest) oldest = date;

      if (!run.rerun && (await hasExecutedRule(run.emailAccountId, message))) {
        counts.skipped += 1;
        continue;
      }

      try {
        await runRules({
          isTest: false,
          provider,
          message,
          rules,
          emailAccount,
          logger: log.with({ messageId: message.id }),
          modelType: "chat",
          skipDraftReplies: run.skipDraftReplies,
        });
        counts.processed += 1;
      } catch (error) {
        log.warn("Bulk run failed on a message", {
          messageId: message.id,
          error,
        });
        counts.failed += 1;
      }
    }

    // A page that moved the cursor nowhere would repeat forever.
    const done = !oldest || (cursor !== undefined && oldest >= cursor);
    cursor = oldest;
    const updated = await prisma.bulkRuleRun.update({
      where: { id: run.id },
      data: {
        cursorBefore: cursor ?? null,
        processed: { increment: counts.processed },
        skipped: { increment: counts.skipped },
        failed: { increment: counts.failed },
        leaseUntil: new Date(Date.now() + LEASE_MS),
      },
      select: { status: true, leaseOwner: true },
    });

    if (done) return "done";
    if (
      updated.status !== BulkRuleRunStatus.RUNNING ||
      updated.leaseOwner !== owner
    ) {
      return "stopped";
    }
  }

  return "continue";
}

async function hasExecutedRule(
  emailAccountId: string,
  message: { id: string; threadId: string },
) {
  const existing = await prisma.executedRule.findFirst({
    where: {
      emailAccountId,
      threadId: message.threadId,
      messageId: message.id,
    },
    select: { id: true },
  });
  return !!existing;
}

async function release(runId: string, owner: string) {
  await prisma.bulkRuleRun.updateMany({
    where: { id: runId, leaseOwner: owner },
    data: { leaseOwner: null, leaseUntil: null },
  });
  return prisma.bulkRuleRun.findUnique({
    where: { id: runId },
    select: { status: true },
  });
}

async function finish(
  runId: string,
  status: BulkRuleRunStatus,
  lastError?: string,
) {
  await prisma.bulkRuleRun.update({
    where: { id: runId },
    data: {
      status,
      finishedAt: new Date(),
      lastError: lastError ?? null,
      leaseOwner: null,
      leaseUntil: null,
    },
  });
}
