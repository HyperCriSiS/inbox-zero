import { z } from "zod";

export const sieveConditionSchema = z.object({
  kind: z.enum(["address", "header", "exists"]),
  header: z.string().trim().min(1).max(200),
  part: z.enum(["all", "domain", "localpart"]).optional(),
  match: z.enum(["is", "contains", "matches"]).optional(),
  value: z.string().max(500).optional(),
});

export const suggestSieveRuleBody = z.object({
  messageId: z.string().min(1),
});

export const planSieveRuleBody = z.object({
  messageId: z.string().min(1),
  conditions: z
    .array(sieveConditionSchema)
    .min(1, "Choose a condition")
    .max(10),
  combine: z.enum(["anyof", "allof"]),
  folder: z.string().trim().min(1, "Choose a folder").max(500),
});
export type PlanSieveRuleBody = z.infer<typeof planSieveRuleBody>;
