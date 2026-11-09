import {
  ActionType,
  ClassificationFeedbackEventType,
} from "@/generated/prisma/enums";
import { extractEmailAddress } from "@/utils/email";
import type { EmailProvider } from "@/utils/email/types";
import type { ImapMailboxRole } from "@/utils/imap/message";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { saveClassificationFeedback } from "@/utils/rule/classification-feedback";
import { isEligibleForClassificationFeedback } from "@/utils/rule/consts";
import { learnColdEmailFromSpam } from "@/utils/webhook/google/process-label-added-event";

// Reading a message costs an IMAP fetch, so a bulk reorganisation in another
// client only teaches from its first moves.
const MAX_MOVES_PER_RUN = 50;

export type ImapMove = {
  messageId: string;
  fromPath: string | null;
  toPath: string;
  toRole: ImapMailboxRole | null;
};

type MoveFeedback = {
  move: ImapMove;
  ruleId: string;
  eventType: ClassificationFeedbackEventType;
};

/**
 * A move found by the sync was made in another client, because the app
 * updates its own rows when it moves mail. Moving mail into the folder of a
 * rule, or out of it back to the inbox, is the IMAP counterpart of adding or
 * removing a Gmail label, so it is saved as the same classification feedback.
 * A move into Junk teaches the sender as a cold emailer, as Gmail spam does.
 */
export async function learnFromImapMoves({
  emailAccountId,
  moves,
  provider,
  logger,
}: {
  emailAccountId: string;
  moves: ImapMove[];
  provider: EmailProvider;
  logger: Logger;
}) {
  if (!moves.length) return 0;

  await learnFromJunkMoves({ emailAccountId, moves, provider, logger });

  const paths = [
    ...new Set(
      moves.flatMap((move) =>
        move.fromPath ? [move.toPath, move.fromPath] : [move.toPath],
      ),
    ),
  ];
  const ruleByPath = await getRulesByFolder(emailAccountId, paths);
  if (!ruleByPath.size) return 0;

  const feedback = moves
    .flatMap((move): MoveFeedback[] => {
      const added = ruleByPath.get(move.toPath);
      if (added) {
        return [
          {
            move,
            ruleId: added,
            eventType: ClassificationFeedbackEventType.LABEL_ADDED,
          },
        ];
      }
      const removed = move.fromPath && ruleByPath.get(move.fromPath);
      if (removed && move.toRole === "inbox") {
        return [
          {
            move,
            ruleId: removed,
            eventType: ClassificationFeedbackEventType.LABEL_REMOVED,
          },
        ];
      }
      return [];
    })
    .slice(0, MAX_MOVES_PER_RUN);
  if (!feedback.length) return 0;

  const messages = await provider.getMessagesBatch(
    feedback.map(({ move }) => move.messageId),
  );
  const messageById = new Map(messages.map((message) => [message.id, message]));

  let saved = 0;
  for (const { move, ruleId, eventType } of feedback) {
    const message = messageById.get(move.messageId);
    const sender = message?.headers.from
      ? extractEmailAddress(message.headers.from)
      : "";
    if (!message || !sender) continue;

    await saveClassificationFeedback({
      emailAccountId,
      sender,
      ruleId,
      threadId: message.threadId,
      messageId: message.id,
      eventType,
      logger,
    });
    saved += 1;
  }

  logger.info("Learned from moves in another client", { saved });
  return saved;
}

// IMAP folder actions store the folder path as their id, and so do labels on
// servers that keep labels as folders, such as Proton Mail Bridge.
async function getRulesByFolder(emailAccountId: string, paths: string[]) {
  const rules = await prisma.rule.findMany({
    where: {
      emailAccountId,
      enabled: true,
      actions: {
        some: {
          OR: [
            { type: ActionType.MOVE_FOLDER, folderId: { in: paths } },
            { type: ActionType.LABEL, labelId: { in: paths } },
          ],
        },
      },
    },
    select: {
      id: true,
      systemType: true,
      actions: { select: { type: true, folderId: true, labelId: true } },
    },
  });

  const ruleByPath = new Map<string, string>();
  for (const rule of rules) {
    if (!isEligibleForClassificationFeedback(rule.systemType)) continue;
    for (const action of rule.actions) {
      const path =
        action.type === ActionType.MOVE_FOLDER
          ? action.folderId
          : action.type === ActionType.LABEL
            ? action.labelId
            : null;
      if (path && paths.includes(path) && !ruleByPath.has(path)) {
        ruleByPath.set(path, rule.id);
      }
    }
  }
  return ruleByPath;
}

async function learnFromJunkMoves({
  emailAccountId,
  moves,
  provider,
  logger,
}: {
  emailAccountId: string;
  moves: ImapMove[];
  provider: EmailProvider;
  logger: Logger;
}) {
  const junked = moves
    .filter((move) => move.toRole === "junk")
    .slice(0, MAX_MOVES_PER_RUN);
  if (!junked.length) return;

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { id: true, email: true },
  });
  if (!emailAccount) return;

  const messages = await provider.getMessagesBatch(
    junked.map((move) => move.messageId),
  );
  // Junking a thread moves each of its messages, but the answer is the same.
  const learnedThreads = new Set<string>();
  for (const message of messages) {
    if (learnedThreads.has(message.threadId)) continue;
    const sender = message.headers.from
      ? extractEmailAddress(message.headers.from)
      : "";
    if (!sender) continue;

    const handled = await learnColdEmailFromSpam({
      sender,
      messageId: message.id,
      threadId: message.threadId,
      emailAccount,
      provider,
      logger,
    });
    if (handled) learnedThreads.add(message.threadId);
  }
}
