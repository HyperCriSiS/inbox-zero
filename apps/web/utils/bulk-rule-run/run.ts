import { addDays } from "date-fns/addDays";
import { startOfDay } from "date-fns/startOfDay";
import { BulkRuleRunStatus } from "@/generated/prisma/enums";
import { runRules } from "@/utils/ai/choose-rule/run-rules";
import { createEmailProvider } from "@/utils/email/provider";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";
import { getEmailAccountForRuleExecution } from "@/utils/user/get";

const BULK_RULE_RUN_QUEUE = "bulk-rule-run";
const PAGE_SIZE = 25;
// Below the route's maxDuration, so a slice always saves its place.
const SLICE_BUDGET_MS = 4 * 60 * 1000;

export type BulkRuleRunBody = { runId: string };

export async function enqueueBulkRuleRun(runId: string, logger: Logger) {
  await enqueueBackgroundJob<BulkRuleRunBody>({
    topic: BULK_RULE_RUN_QUEUE,
    body: { runId },
    qstash: {
      queueName: BULK_RULE_RUN_QUEUE,
      // One slice per run at a time; each slice enqueues the next.
      parallelism: 3,
      path: "/api/bulk-rule-run",
    },
    logger,
  });
}

/**
 * Processes one slice of a run: pages through the inbox from the saved page
 * token and runs the rules on the newest message of each thread, like the
 * browser-driven bulk run. Progress is saved after every page, so a crash or
 * a pause loses at most one page. When time is up the next slice is queued.
 */
export async function processBulkRuleRunSlice({
  runId,
  logger,
}: {
  runId: string;
  logger: Logger;
}) {
  const run = await prisma.bulkRuleRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== BulkRuleRunStatus.RUNNING) return "idle";
  const log = logger.with({ runId, emailAccountId: run.emailAccountId });

  const emailAccount = await getEmailAccountForRuleExecution({
    emailAccountId: run.emailAccountId,
  });
  if (!emailAccount) {
    await finish(runId, BulkRuleRunStatus.FAILED, "Email account not found");
    return "failed";
  }

  let provider: EmailProvider;
  try {
    provider = await createEmailProvider({
      emailAccountId: run.emailAccountId,
      provider: emailAccount.account.provider,
      logger: log,
    });
  } catch (error) {
    log.warn("Bulk run could not reach the mailbox", { error });
    await finish(
      runId,
      BulkRuleRunStatus.FAILED,
      "Could not reach the mailbox",
    );
    return "failed";
  }

  const rules = await prisma.rule.findMany({
    where: { emailAccountId: run.emailAccountId, enabled: true },
    include: { actions: true },
  });

  // Provider "before" filters are exclusive; the selected day is inclusive.
  const before = run.endDate ? startOfDay(addDays(run.endDate, 1)) : undefined;
  const started = Date.now();
  let pageToken = run.pageToken ?? undefined;

  while (Date.now() - started < SLICE_BUDGET_MS) {
    const page = await provider.getThreadsWithQuery({
      query: {
        type: "inbox",
        after: run.startDate,
        ...(before ? { before } : {}),
        ...(run.includeRead ? {} : { isUnread: true }),
      },
      maxResults: PAGE_SIZE,
      pageToken,
    });

    const counts = { processed: 0, skipped: 0, failed: 0 };
    for (const thread of page.threads) {
      const message = thread.messages?.at(-1);
      if (!message) continue;

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

    pageToken = page.nextPageToken ?? undefined;
    const updated = await prisma.bulkRuleRun.update({
      where: { id: runId },
      data: {
        pageToken: pageToken ?? null,
        processed: { increment: counts.processed },
        skipped: { increment: counts.skipped },
        failed: { increment: counts.failed },
      },
      select: { status: true },
    });

    if (!pageToken) {
      await finish(runId, BulkRuleRunStatus.COMPLETED);
      return "completed";
    }
    // Paused or stopped from the app while this page ran.
    if (updated.status !== BulkRuleRunStatus.RUNNING) return "idle";
  }

  await enqueueBulkRuleRun(runId, log);
  return "continued";
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

async function finish(
  runId: string,
  status: BulkRuleRunStatus,
  lastError?: string,
) {
  await prisma.bulkRuleRun.update({
    where: { id: runId },
    data: { status, finishedAt: new Date(), lastError: lastError ?? null },
  });
}
