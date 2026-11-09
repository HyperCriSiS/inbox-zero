"use server";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { actionClientUser } from "@/utils/actions/safe-action";
import { linkImapAccountBody } from "@/utils/actions/imap.validation";
import { isImapProvider } from "@/utils/email/provider-types";
import { SafeError } from "@/utils/error";
import {
  ImapConnectionPolicyError,
  withImapClient,
} from "@/utils/imap/connection";
import { verifySmtp } from "@/utils/imap/smtp";
import { syncImapAccount } from "@/utils/imap/sync";
import { checkRateLimit, createRateLimitKey } from "@/utils/rate-limit";
import prisma from "@/utils/prisma";

export const linkImapAccountAction = actionClientUser
  .metadata({ name: "linkImapAccount" })
  .inputSchema(linkImapAccountBody)
  .action(async ({ ctx: { userId, logger }, parsedInput: input }) => {
    // Every attempt makes this server log in somewhere on the user's behalf.
    const { limited } = await checkRateLimit({
      rule: {
        key: createRateLimitKey(["rate-limit", "imap-link", userId]),
        limit: 10,
        windowSeconds: 10 * 60,
      },
      logger,
    });
    if (limited) {
      throw new SafeError("Too many attempts. Try again in a few minutes.");
    }

    const existing = await prisma.emailAccount.findUnique({
      where: { email: input.email },
      select: {
        id: true,
        userId: true,
        accountId: true,
        account: { select: { provider: true } },
      },
    });
    const isRelink =
      !!existing &&
      existing.userId === userId &&
      isImapProvider(existing.account.provider);
    if (existing && !isRelink) {
      throw new SafeError("This email address is already linked");
    }

    const emailAccountId = existing?.id ?? randomUUID();
    const config = {
      emailAccountId,
      imap: {
        host: input.imapHost,
        port: input.imapPort,
        security: input.imapSecurity,
      },
      smtp: {
        host: input.smtpHost,
        port: input.smtpPort,
        security: input.smtpSecurity,
      },
      username: input.username,
      password: input.password,
      tlsPinnedCertPem: input.tlsPinnedCertPem || null,
    };

    try {
      await withImapClient(config, logger, async () => undefined);
      await verifySmtp(config);
    } catch (error) {
      logger.warn("IMAP connection check failed", { error });
      // Raw errors would let any signed-in user probe servers through this form.
      throw new SafeError(
        error instanceof ImapConnectionPolicyError
          ? error.message
          : "Could not sign in to the mail server. Check the settings and password.",
      );
    }

    const settings = {
      imapHost: input.imapHost,
      imapPort: input.imapPort,
      imapSecurity: input.imapSecurity,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpSecurity: input.smtpSecurity,
      username: input.username,
      password: input.password,
      tlsPinnedCertPem: input.tlsPinnedCertPem || null,
    };

    if (existing) {
      const previous = await prisma.imapConnection.findUniqueOrThrow({
        where: { emailAccountId },
        select: { id: true, imapHost: true, username: true },
      });
      // Sync state stays, so a new password does not reprocess the mailbox.
      // Another server or login is another mailbox, where the indexed UIDs
      // would address unrelated mail.
      const sameMailbox =
        previous.imapHost.toLowerCase() === input.imapHost.toLowerCase() &&
        previous.username === input.username;
      const dropped = sameMailbox
        ? []
        : await prisma.imapMessage.findMany({
            where: { connectionId: previous.id },
            select: { id: true },
          });

      await prisma.$transaction([
        ...(sameMailbox
          ? []
          : [
              prisma.imapMailbox.deleteMany({
                where: { connectionId: previous.id },
              }),
              prisma.imapSyncItem.deleteMany({
                where: { connectionId: previous.id },
              }),
              // The local mail client learns of removals from this feed.
              prisma.imapChange.createMany({
                data: dropped.map(({ id }) => ({
                  connectionId: previous.id,
                  messageId: id,
                  kind: "delete",
                })),
              }),
            ]),
        prisma.imapConnection.update({
          where: { emailAccountId },
          data: { ...settings, lastSyncError: null },
        }),
        prisma.account.update({
          where: { id: existing.accountId },
          data: { disconnectedAt: null },
        }),
      ]);
      return { emailAccountId };
    }

    // Encryption is a per-model query extension, which skips nested writes, so
    // ImapConnection must be its own top-level create to not store plaintext.
    await prisma.$transaction([
      prisma.account.create({
        data: {
          userId,
          provider: "imap",
          providerAccountId: input.email,
          type: "credential",
          emailAccount: {
            create: {
              id: emailAccountId,
              userId,
              email: input.email,
              name: input.name || input.email.split("@")[0],
            },
          },
        },
      }),
      prisma.imapConnection.create({
        data: { emailAccountId, ...settings },
      }),
    ]);

    after(() =>
      syncImapAccount({
        emailAccountId,
        logger: logger.with({ emailAccountId }),
      }),
    );

    return { emailAccountId };
  });
