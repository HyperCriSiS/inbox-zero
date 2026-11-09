import type { ImapFlow } from "imapflow";
import { withImapClient } from "@/utils/imap/connection";
import { getImapConfig, isAuthenticationFailure } from "@/utils/imap/config";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

// IDLE is restarted this often, so the socket timeout never fires on a quiet
// mailbox and NAT routers keep the connection.
const IDLE_RESTART_MS = 60_000;
const RECONCILE_MS = 60_000;
const NEW_MAIL_DEBOUNCE_MS = 2000;
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 5 * 60_000;

type Watcher = { abort: AbortController; version: number };
type IdleOptions = {
  logger: Logger;
  onNewMail: (emailAccountId: string) => Promise<void>;
  /** Called once the inbox is open and waiting for new mail. */
  onWatching?: (emailAccountId: string) => void;
};

/**
 * Keeps one IMAP IDLE connection per linked account open on the inbox and
 * starts a sync as soon as the server reports new mail, so mail does not wait
 * for the next poll. Polling keeps running: it catches everything outside the
 * inbox and any account whose server has no IDLE.
 */
export function startImapIdle({ logger, onNewMail, onWatching }: IdleOptions) {
  const watchers = new Map<string, Watcher>();
  let stopped = false;

  const reconcile = async () => {
    const connections = await prisma.imapConnection.findMany({
      where: { emailAccount: { account: { disconnectedAt: null } } },
      select: { emailAccountId: true, updatedAt: true },
    });
    if (stopped) return;

    const wanted = new Map(
      connections.map((c) => [c.emailAccountId, c.updatedAt.getTime()]),
    );
    for (const [emailAccountId, watcher] of watchers) {
      // A changed row may carry a new password or server, so reconnect.
      if (wanted.get(emailAccountId) !== watcher.version) {
        watcher.abort.abort();
        watchers.delete(emailAccountId);
      }
    }
    for (const [emailAccountId, version] of wanted) {
      if (watchers.has(emailAccountId)) continue;
      const watcher = { abort: new AbortController(), version };
      watchers.set(emailAccountId, watcher);
      void watchAccount({
        emailAccountId,
        signal: watcher.abort.signal,
        logger: logger.with({ emailAccountId }),
        onNewMail,
        onWatching: () => onWatching?.(emailAccountId),
      }).finally(() => {
        // Stopped for good, such as a server without IDLE. The next
        // reconcile retries only when the row changes.
        if (
          watchers.get(emailAccountId) === watcher &&
          !watcher.abort.signal.aborted
        ) {
          watcher.abort.abort();
        }
      });
    }
  };

  const runReconcile = () =>
    reconcile().catch((error) =>
      logger.warn("IMAP IDLE reconcile failed", { error }),
    );
  void runReconcile();
  const timer = setInterval(runReconcile, RECONCILE_MS);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const watcher of watchers.values()) watcher.abort.abort();
      watchers.clear();
    },
    watchedAccountIds: () =>
      [...watchers.entries()]
        .filter(([, watcher]) => !watcher.abort.signal.aborted)
        .map(([emailAccountId]) => emailAccountId),
  };
}

async function watchAccount({
  emailAccountId,
  signal,
  logger,
  onNewMail,
  onWatching,
}: {
  emailAccountId: string;
  signal: AbortSignal;
  logger: Logger;
  onNewMail: (emailAccountId: string) => Promise<void>;
  onWatching: () => void;
}) {
  let retryMs = RETRY_MIN_MS;

  while (!signal.aborted) {
    try {
      const config = await getImapConfig(emailAccountId);
      const outcome = await withImapClient(
        config,
        logger,
        (client) =>
          idleOnInbox({
            client,
            signal,
            logger,
            notify: () => onNewMail(emailAccountId),
            onWatching,
          }),
        { maxIdleTime: IDLE_RESTART_MS },
      );
      if (outcome === "unsupported") {
        logger.info("Server has no IDLE, relying on polling");
        return;
      }
      retryMs = RETRY_MIN_MS;
    } catch (error) {
      // Retrying a rejected password gets the account locked. The sync marks
      // it disconnected, which ends this watcher on the next reconcile.
      if (isAuthenticationFailure(error)) {
        logger.warn("IMAP IDLE stopped after a rejected password");
        return;
      }
      logger.warn("IMAP IDLE connection failed", { error, retryMs });
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    }

    await sleep(retryMs, signal);
  }
}

async function idleOnInbox({
  client,
  signal,
  logger,
  notify,
  onWatching,
}: {
  client: ImapFlow;
  signal: AbortSignal;
  logger: Logger;
  notify: () => Promise<void>;
  onWatching: () => void;
}): Promise<"closed" | "unsupported"> {
  if (!client.capabilities.has("IDLE")) return "unsupported";

  let debounce: ReturnType<typeof setTimeout> | undefined;
  const onExists = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      notify().catch((error) =>
        logger.warn("Could not start a sync after new mail", { error }),
      );
    }, NEW_MAIL_DEBOUNCE_MS);
  };

  client.on("exists", onExists);
  try {
    await client.mailboxOpen("INBOX", { readOnly: true });
    logger.trace("IMAP IDLE watching the inbox");
    onWatching();
    // Auto IDLE does not start reliably on every server, Stalwart among them,
    // so IDLE is entered by hand and again whenever a command ends it.
    void (async () => {
      while (!signal.aborted && client.usable) {
        await client.idle();
        // Guards against a server that ends IDLE at once; mail that arrives
        // meanwhile is reported when IDLE starts again.
        await sleep(1000, signal);
      }
    })().catch((error) => logger.trace("IDLE ended", { error }));
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      client.once("close", () => resolve());
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    client.off("exists", onExists);
    clearTimeout(debounce);
  }
  return "closed";
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms * (0.8 + Math.random() * 0.4));
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
