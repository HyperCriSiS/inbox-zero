"use server";

import { BulkRuleRunStatus } from "@/generated/prisma/enums";
import { env } from "@/env";
import { actionClient } from "@/utils/actions/safe-action";
import {
  bulkRuleRunIdBody,
  startBulkRuleRunBody,
} from "@/utils/actions/bulk-rule-run.validation";
import { enqueueBulkRuleRun } from "@/utils/bulk-rule-run/run";
import { SafeError } from "@/utils/error";
import { RERUN_MINIMUM_TIER } from "@/utils/premium/rerun";
import { checkHasAccess } from "@/utils/premium/server";
import prisma from "@/utils/prisma";

const ACTIVE = [BulkRuleRunStatus.RUNNING, BulkRuleRunStatus.PAUSED];

export const startBulkRuleRunAction = actionClient
  .metadata({ name: "startBulkRuleRun" })
  .inputSchema(startBulkRuleRunBody)
  .action(async ({ ctx: { emailAccountId, userId, logger }, parsedInput }) => {
    // The same limits as the run in the browser.
    if (
      parsedInput.includeRead &&
      !(await checkHasAccess({ userId, minimumTier: "PROFESSIONAL_MONTHLY" }))
    ) {
      throw new SafeError("Including read emails needs a higher plan.");
    }
    if (
      parsedInput.rerun &&
      !(await checkHasAccess({ userId, minimumTier: RERUN_MINIMUM_TIER }))
    ) {
      throw new SafeError("Rerunning rules needs a higher plan.");
    }

    // Trials are capped in the browser; a background run has no such cap.
    if (!env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { premium: { select: { stripeSubscriptionStatus: true } } },
      });
      if (user?.premium?.stripeSubscriptionStatus === "trialing") {
        throw new SafeError("Background runs are available after the trial.");
      }
    }

    const active = await prisma.bulkRuleRun.findFirst({
      where: { emailAccountId, status: { in: ACTIVE } },
      select: { id: true },
    });
    if (active) throw new SafeError("A background run is already in progress.");

    const run = await prisma.bulkRuleRun.create({
      data: {
        emailAccountId,
        startDate: parsedInput.startDate,
        endDate: parsedInput.endDate ?? null,
        includeRead: parsedInput.includeRead,
        rerun: parsedInput.rerun,
        skipDraftReplies: !parsedInput.generateDraftReplies,
      },
      select: { id: true },
    });
    await enqueueBulkRuleRun(run.id, logger);
    return { runId: run.id };
  });

export const pauseBulkRuleRunAction = actionClient
  .metadata({ name: "pauseBulkRuleRun" })
  .inputSchema(bulkRuleRunIdBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { runId } }) => {
    await prisma.bulkRuleRun.updateMany({
      where: { id: runId, emailAccountId, status: BulkRuleRunStatus.RUNNING },
      data: { status: BulkRuleRunStatus.PAUSED },
    });
  });

export const resumeBulkRuleRunAction = actionClient
  .metadata({ name: "resumeBulkRuleRun" })
  .inputSchema(bulkRuleRunIdBody)
  .action(
    async ({ ctx: { emailAccountId, logger }, parsedInput: { runId } }) => {
      const resumed = await prisma.bulkRuleRun.updateMany({
        where: { id: runId, emailAccountId, status: BulkRuleRunStatus.PAUSED },
        data: { status: BulkRuleRunStatus.RUNNING },
      });
      if (resumed.count) await enqueueBulkRuleRun(runId, logger);
    },
  );

export const cancelBulkRuleRunAction = actionClient
  .metadata({ name: "cancelBulkRuleRun" })
  .inputSchema(bulkRuleRunIdBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { runId } }) => {
    await prisma.bulkRuleRun.updateMany({
      where: { id: runId, emailAccountId, status: { in: ACTIVE } },
      data: { status: BulkRuleRunStatus.CANCELLED, finishedAt: new Date() },
    });
  });
