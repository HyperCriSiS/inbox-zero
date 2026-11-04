import { LabelCleanupAction } from "@/generated/prisma/enums";
import { internalDateToDate } from "@/utils/date";
import { createEmailProvider } from "@/utils/email/provider";
import type { EmailProvider, EmailThread } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

const DAY_MS = 86_400_000;
const PAGE_SIZE = 50;
// A large backlog drains over a few runs; the oldest mail comes first each time.
const MAX_THREADS_PER_RUN = 500;

export async function runLabelCleanups(logger: Logger) {
  const cleanups = await prisma.labelCleanup.findMany({
    where: { emailAccount: { account: { disconnectedAt: null } } },
    include: {
      emailAccount: {
        select: { email: true, account: { select: { provider: true } } },
      },
    },
    orderBy: { emailAccountId: "asc" },
  });

  const results: { id: string; threads: number; error?: string }[] = [];
  for (const cleanup of cleanups) {
    const log = logger.with({
      emailAccountId: cleanup.emailAccountId,
      labelCleanupId: cleanup.id,
    });
    try {
      const provider = await createEmailProvider({
        emailAccountId: cleanup.emailAccountId,
        provider: cleanup.emailAccount.account.provider,
        logger: log,
      });
      const threads = await cleanUpLabel({
        provider,
        ownerEmail: cleanup.emailAccount.email,
        labelId: cleanup.labelId,
        action: cleanup.action,
        olderThan: new Date(Date.now() - cleanup.afterDays * DAY_MS),
        logger: log,
      });
      await prisma.labelCleanup.update({
        where: { id: cleanup.id },
        data: { lastRunAt: new Date(), lastRunCount: threads },
      });
      results.push({ id: cleanup.id, threads });
    } catch (error) {
      log.error("Label cleanup failed", { error });
      results.push({ id: cleanup.id, threads: 0, error: "failed" });
    }
  }
  return results;
}

/**
 * Applies the action to threads under the label whose newest message is older
 * than the cutoff. Each thread is checked here as well, so a provider that
 * ignored a filter can never sweep up mail outside the label.
 */
export async function cleanUpLabel({
  provider,
  ownerEmail,
  labelId,
  action,
  olderThan,
  logger,
}: {
  provider: EmailProvider;
  ownerEmail: string;
  labelId: string;
  action: LabelCleanupAction;
  olderThan: Date;
  logger: Logger;
}) {
  let pageToken: string | undefined;
  let handled = 0;

  while (handled < MAX_THREADS_PER_RUN) {
    const page = await provider.getThreadsWithQuery({
      query: { labelId, before: olderThan },
      maxResults: PAGE_SIZE,
      pageToken,
      messageFormat: "metadata",
    });

    for (const thread of page.threads) {
      if (handled >= MAX_THREADS_PER_RUN) break;
      if (!isDue(thread, labelId, olderThan)) continue;
      try {
        await applyAction({ provider, ownerEmail, labelId, action, thread });
        handled += 1;
      } catch (error) {
        // One thread that cannot be changed must not stop the rest.
        logger.warn("Label cleanup skipped a thread", {
          threadId: thread.id,
          error,
        });
      }
    }

    pageToken = page.nextPageToken ?? undefined;
    // Removing the label or moving the mail takes it out of the next page,
    // but a page of skipped threads would repeat, so follow the token.
    if (!pageToken) break;
  }

  logger.info("Label cleanup finished", { action, threads: handled });
  return handled;
}

function isDue(thread: EmailThread, labelId: string, olderThan: Date) {
  const messages = thread.messages ?? [];
  if (!messages.length) return false;
  if (!messages.some((message) => message.labelIds?.includes(labelId))) {
    return false;
  }
  // A reply in the thread restarts the clock.
  return messages.every((message) => {
    const date = internalDateToDate(message.internalDate, {
      fallbackToNow: true,
    });
    return date < olderThan;
  });
}

async function applyAction({
  provider,
  ownerEmail,
  labelId,
  action,
  thread,
}: {
  provider: EmailProvider;
  ownerEmail: string;
  labelId: string;
  action: LabelCleanupAction;
  thread: EmailThread;
}) {
  switch (action) {
    case LabelCleanupAction.REMOVE_LABEL:
      return provider.removeThreadLabel(thread.id, labelId);
    case LabelCleanupAction.ARCHIVE:
      return provider.archiveThread(thread.id, ownerEmail);
    case LabelCleanupAction.TRASH:
      // Goes through REVIEW_BEFORE_DELETE_LABEL like every other trash.
      return provider.trashThread(thread.id, ownerEmail, "automation");
  }
}
