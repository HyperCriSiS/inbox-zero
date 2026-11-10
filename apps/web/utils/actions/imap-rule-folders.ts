"use server";

import { actionClient } from "@/utils/actions/safe-action";
import { saveImapRuleFoldersBody } from "@/utils/actions/imap-rule-folders.validation";
import { SafeError } from "@/utils/error";
import { isRuleFolderCandidate } from "@/utils/imap/sync-plan";
import prisma from "@/utils/prisma";

export const saveImapRuleFoldersAction = actionClient
  .metadata({ name: "saveImapRuleFolders" })
  .inputSchema(saveImapRuleFoldersBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { folders } }) => {
    const connection = await prisma.imapConnection.findUnique({
      where: { emailAccountId },
      select: { id: true, mailboxes: { select: { path: true, role: true } } },
    });
    if (!connection) throw new SafeError("This is not an IMAP account");

    const allowed = new Set(
      connection.mailboxes
        .filter(isRuleFolderCandidate)
        .map(({ path }) => path),
    );
    if (folders.some((path) => !allowed.has(path))) {
      throw new SafeError("Choose folders of this mailbox");
    }

    await prisma.imapConnection.update({
      where: { id: connection.id },
      data: { ruleFolders: [...new Set(folders)] },
    });
  });
