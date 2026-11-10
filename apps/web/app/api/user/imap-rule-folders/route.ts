import { NextResponse } from "next/server";
import { isRuleFolderCandidate } from "@/utils/imap/sync-plan";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";

export type GetImapRuleFoldersResponse = Awaited<ReturnType<typeof getData>>;

export const GET = withEmailAccount("user/imap-rule-folders", async (request) =>
  NextResponse.json(await getData(request.auth.emailAccountId)),
);

async function getData(emailAccountId: string) {
  const connection = await prisma.imapConnection.findUnique({
    where: { emailAccountId },
    select: {
      ruleFolders: true,
      mailboxes: {
        select: { path: true, role: true },
        orderBy: { path: "asc" },
      },
    },
  });
  const folders = (connection?.mailboxes ?? [])
    .filter(isRuleFolderCandidate)
    .map(({ path }) => path);
  // A chosen folder can be renamed or deleted on the server since.
  return {
    folders,
    selected: (connection?.ruleFolders ?? []).filter((path) =>
      folders.includes(path),
    ),
  };
}
