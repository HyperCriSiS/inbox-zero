"use server";

import { actionClient } from "@/utils/actions/safe-action";
import {
  deleteLabelCleanupBody,
  saveLabelCleanupBody,
} from "@/utils/actions/label-cleanup.validation";
import prisma from "@/utils/prisma";

export const saveLabelCleanupAction = actionClient
  .metadata({ name: "saveLabelCleanup" })
  .inputSchema(saveLabelCleanupBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput }) => {
    const { labelId, labelName, afterDays, action } = parsedInput;
    await prisma.labelCleanup.upsert({
      where: { emailAccountId_labelId: { emailAccountId, labelId } },
      create: { emailAccountId, labelId, labelName, afterDays, action },
      update: { labelName, afterDays, action },
    });
  });

export const deleteLabelCleanupAction = actionClient
  .metadata({ name: "deleteLabelCleanup" })
  .inputSchema(deleteLabelCleanupBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { id } }) => {
    await prisma.labelCleanup.deleteMany({ where: { id, emailAccountId } });
  });
