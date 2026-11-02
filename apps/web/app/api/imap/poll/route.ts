import { NextResponse } from "next/server";
import { hasCronSecret } from "@/utils/cron";
import { captureException } from "@/utils/error";
import { enqueueImapAccounts } from "@/utils/imap/sync";
import { withError } from "@/utils/middleware";

export const dynamic = "force-dynamic";

export const GET = withError("imap/poll", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(new Error("Unauthorized cron request: api/imap/poll"));
    return new Response("Unauthorized", { status: 401 });
  }

  const total = await enqueueImapAccounts(request.logger);

  return NextResponse.json({ total });
});
