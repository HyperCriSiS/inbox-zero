import type { ImapLabelStrategy } from "@/utils/imap/capabilities";
import type { ImapConfig, ImapSecurity } from "@/utils/imap/connection";
import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";

export type ImapAccount = ImapConfig & {
  connectionId: string;
  email: string;
  labelStrategy: ImapLabelStrategy;
};

export async function getImapConfig(
  emailAccountId: string,
): Promise<ImapAccount> {
  const connection = await prisma.imapConnection.findUniqueOrThrow({
    where: { emailAccountId },
    include: {
      emailAccount: {
        select: {
          email: true,
          account: { select: { disconnectedAt: true } },
        },
      },
    },
  });

  // Every retry with a rejected password counts towards the server's lockout.
  if (connection.emailAccount.account.disconnectedAt) {
    throw new SafeError(
      "The mail server rejected the login. Update the password under Accounts.",
    );
  }

  return {
    emailAccountId,
    connectionId: connection.id,
    email: connection.emailAccount.email,
    labelStrategy: connection.labelStrategy as ImapLabelStrategy,
    imap: {
      host: connection.imapHost,
      port: connection.imapPort,
      security: connection.imapSecurity as ImapSecurity,
    },
    smtp: {
      host: connection.smtpHost,
      port: connection.smtpPort,
      security: connection.smtpSecurity as ImapSecurity,
    },
    username: connection.username,
    password: connection.password,
    tlsPinnedCertPem: connection.tlsPinnedCertPem,
  };
}

export async function markImapDisconnected(emailAccountId: string) {
  await prisma.account.updateMany({
    where: { emailAccount: { id: emailAccountId } },
    data: { disconnectedAt: new Date() },
  });
}

// The IMAP library flags every refused login. These response codes mean the
// server could not check the password right now, not that it is wrong.
const TEMPORARY_LOGIN_CODES = new Set([
  "UNAVAILABLE",
  "INUSE",
  "LIMIT",
  "SERVERBUG",
]);

export function isAuthenticationFailure(error: unknown) {
  if (
    typeof error !== "object" ||
    error === null ||
    !("authenticationFailed" in error) ||
    !error.authenticationFailed
  ) {
    return false;
  }
  const code =
    "serverResponseCode" in error ? String(error.serverResponseCode) : "";
  return !TEMPORARY_LOGIN_CODES.has(code.toUpperCase());
}
