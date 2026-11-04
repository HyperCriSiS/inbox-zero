import { z } from "zod";
import { LabelCleanupAction } from "@/generated/prisma/enums";

export const saveLabelCleanupBody = z.object({
  labelId: z.string().trim().min(1, "Choose a label"),
  labelName: z.string().trim().min(1).max(255),
  afterDays: z.coerce
    .number()
    .int()
    .min(1, "At least one day")
    .max(3650, "At most ten years"),
  action: z.enum([
    LabelCleanupAction.REMOVE_LABEL,
    LabelCleanupAction.ARCHIVE,
    LabelCleanupAction.TRASH,
  ]),
});
export type SaveLabelCleanupBody = z.infer<typeof saveLabelCleanupBody>;

export const deleteLabelCleanupBody = z.object({ id: z.string().min(1) });
