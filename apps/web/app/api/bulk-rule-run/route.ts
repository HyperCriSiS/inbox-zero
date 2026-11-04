import { z } from "zod";
import { processBulkRuleRunSlice } from "@/utils/bulk-rule-run/run";
import { withError } from "@/utils/middleware";
import { withQstashOrInternal } from "@/utils/qstash";

export const maxDuration = 300;

const bulkRuleRunBody = z.object({ runId: z.string().min(1) });

export const POST = withError(
  "bulk-rule-run",
  withQstashOrInternal(async (request) => {
    const body = bulkRuleRunBody.safeParse(await request.json());
    if (!body.success) return new Response("Invalid payload", { status: 400 });

    const result = await processBulkRuleRunSlice({
      runId: body.data.runId,
      logger: request.logger,
    });
    return Response.json({ result });
  }),
);
