import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";

export type GetBulkRuleRunResponse = Awaited<ReturnType<typeof getData>>;

export const GET = withEmailAccount("user/bulk-rule-run", async (request) =>
  NextResponse.json(await getData(request.auth.emailAccountId)),
);

async function getData(emailAccountId: string) {
  const run = await prisma.bulkRuleRun.findFirst({
    where: { emailAccountId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      startDate: true,
      endDate: true,
      processed: true,
      skipped: true,
      failed: true,
      lastError: true,
      createdAt: true,
      finishedAt: true,
    },
  });
  return { run };
}
