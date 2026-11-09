import { startImapIdle } from "@/utils/imap/idle";
import { enqueueImapAccountSync } from "@/utils/imap/sync";
import { createScopedLogger } from "@/utils/logger";

const globalForIdle = globalThis as {
  imapIdle?: ReturnType<typeof startImapIdle>;
};

/** Started once per server process. Development reloads must not add more. */
export function startImapIdleInProcess() {
  if (globalForIdle.imapIdle) return;
  const logger = createScopedLogger("imap-idle");
  globalForIdle.imapIdle = startImapIdle({
    logger,
    onNewMail: (emailAccountId) =>
      enqueueImapAccountSync(emailAccountId, logger),
  });
  logger.info("IMAP IDLE started");
}
