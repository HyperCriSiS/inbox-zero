"use server";

import { actionClient } from "@/utils/actions/safe-action";
import {
  planSieveRuleBody,
  suggestSieveRuleBody,
} from "@/utils/actions/sieve.validation";
import { createEmailProvider } from "@/utils/email/provider";
import {
  callSieveTool,
  headerBlock,
  sieveApplySchema,
  sieveFoldersSchema,
  sievePlanSchema,
  sieveSuggestionsSchema,
  toMessages,
} from "@/utils/sieve/sieve-server";

export const suggestSieveRuleAction = actionClient
  .metadata({ name: "suggestSieveRule" })
  .inputSchema(suggestSieveRuleBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { messageId },
    }) => {
      const headers = await readHeaders({
        emailAccountId,
        provider,
        messageId,
        logger,
      });
      const [suggested, folders] = await Promise.all([
        callSieveTool({
          emailAccountId,
          tool: "suggest_rule",
          args: { headers },
          logger,
        }),
        callSieveTool({
          emailAccountId,
          tool: "list_folders",
          args: {},
          logger,
        }),
      ]);
      const {
        folders: list,
        labels,
        system,
      } = sieveFoldersSchema.parse(folders);

      return {
        suggestions: sieveSuggestionsSchema.parse(suggested).suggestions,
        folders: [
          ...new Set([...(system ?? []), ...(list ?? []), ...(labels ?? [])]),
        ],
      };
    },
  );

export const planSieveRuleAction = actionClient
  .metadata({ name: "planSieveRule" })
  .inputSchema(planSieveRuleBody)
  .action(async ({ ctx: { emailAccountId, provider, logger }, parsedInput }) =>
    toPlanView(
      sievePlanSchema.parse(
        await callSieveTool({
          emailAccountId,
          tool: "plan_rule",
          args: await ruleArgs({
            emailAccountId,
            provider,
            logger,
            parsedInput,
          }),
          logger,
        }),
      ),
    ),
  );

export const applySieveRuleAction = actionClient
  .metadata({ name: "applySieveRule" })
  .inputSchema(planSieveRuleBody)
  .action(
    async ({ ctx: { emailAccountId, provider, logger }, parsedInput }) => {
      const applied = sieveApplySchema.parse(
        await callSieveTool({
          emailAccountId,
          tool: "apply_rule",
          args: await ruleArgs({
            emailAccountId,
            provider,
            logger,
            parsedInput,
          }),
          logger,
        }),
      );
      return {
        ...toPlanView(applied),
        saved: applied.saved,
        reason: applied.reason,
      };
    },
  );

async function ruleArgs({
  emailAccountId,
  provider,
  logger,
  parsedInput: { messageId, conditions, combine, folder },
}: {
  emailAccountId: string;
  provider: string;
  logger: Parameters<typeof createEmailProvider>[0]["logger"];
  parsedInput: {
    messageId: string;
    conditions: unknown[];
    combine: "anyof" | "allof";
    folder: string;
  };
}) {
  return {
    rule: {
      conditions,
      combine,
      // Without stop, later filters could file the same mail a second time.
      actions: { fileinto: folder, stop: true },
    },
    // Lets the server simulate where this very mail would end up.
    headers: await readHeaders({ emailAccountId, provider, messageId, logger }),
  };
}

async function readHeaders({
  emailAccountId,
  provider,
  messageId,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  messageId: string;
  logger: Parameters<typeof createEmailProvider>[0]["logger"];
}) {
  const emailProvider = await createEmailProvider({
    emailAccountId,
    provider,
    logger,
  });
  return headerBlock(await emailProvider.getMessageSource(messageId));
}

function toPlanView(plan: ReturnType<typeof sievePlanSchema.parse>) {
  return {
    description: plan.description ?? "",
    target: plan.target.name,
    newFilter: !!plan.target.newFilter,
    notes: toMessages(plan.notes),
    conflicts: toMessages(plan.conflicts),
    errors: toMessages(plan.errors),
    diff: plan.diff?.text ?? "",
    lands: plan.result ? landsIn(plan.result) : null,
  };
}

// Proton reports the location and the same folder again by its own name.
function landsIn(result: {
  location?: string | null;
  folders?: string[] | null;
}) {
  const names = [result.location, ...(result.folders ?? [])].filter(
    (name): name is string => !!name,
  );
  const seen = new Set<string>();
  return names
    .filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(", ");
}
