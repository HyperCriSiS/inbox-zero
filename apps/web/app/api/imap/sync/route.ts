import { z } from "zod";
import { syncImapAccount } from "@/utils/imap/sync";
import { withError } from "@/utils/middleware";
import { withQstashOrInternal } from "@/utils/qstash";

export const maxDuration = 300;

const imapSyncBody = z.object({ emailAccountId: z.string().min(1) });

export const POST = withError(
  "imap/sync",
  withQstashOrInternal(async (request) => {
    const body = imapSyncBody.safeParse(await request.json());
    if (!body.success) return new Response("Invalid payload", { status: 400 });

    const result = await syncImapAccount({
      emailAccountId: body.data.emailAccountId,
      logger: request.logger,
    });

    return Response.json(result, {
      status: result.status === "error" ? 503 : 200,
    });
  }),
);
