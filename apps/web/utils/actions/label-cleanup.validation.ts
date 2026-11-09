import { z } from "zod";
import { LabelCleanupAction } from "@/generated/prisma/enums";

const SYSTEM_LABEL_IDS = new Set([
  "INBOX",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "STARRED",
  "IMPORTANT",
  "UNREAD",
  "CHAT",
]);

export const saveLabelCleanupBody = z.object({
  labelId: z
    .string()
    .trim()
    .min(1, "Choose a label")
    // Gmail system labels would sweep the inbox, sent mail or drafts.
    .refine((id) => !SYSTEM_LABEL_IDS.has(id.toUpperCase()), {
      message: "Choose one of your own labels",
    }),
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
