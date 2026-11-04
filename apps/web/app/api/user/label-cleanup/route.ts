import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";

export type GetLabelCleanupsResponse = Awaited<ReturnType<typeof getData>>;

export const GET = withEmailAccount("user/label-cleanup", async (request) =>
  NextResponse.json(await getData(request.auth.emailAccountId)),
);

async function getData(emailAccountId: string) {
  const cleanups = await prisma.labelCleanup.findMany({
    where: { emailAccountId },
    select: {
      id: true,
      labelId: true,
      labelName: true,
      afterDays: true,
      action: true,
      lastRunAt: true,
      lastRunCount: true,
    },
    orderBy: { labelName: "asc" },
  });
  return { cleanups };
}
