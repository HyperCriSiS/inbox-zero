import { z } from "zod";

export const startBulkRuleRunBody = z.object({
  startDate: z.coerce.date(),
  endDate: z.coerce.date().nullish(),
  includeRead: z.boolean(),
  rerun: z.boolean(),
  generateDraftReplies: z.boolean(),
});
export type StartBulkRuleRunBody = z.infer<typeof startBulkRuleRunBody>;

export const bulkRuleRunIdBody = z.object({ runId: z.string().min(1) });
