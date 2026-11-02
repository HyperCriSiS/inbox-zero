import { NextResponse } from "next/server";
import { hasCronSecret } from "@/utils/cron";
import { captureException } from "@/utils/error";
import { pollImapAccounts } from "@/utils/imap/sync";
import { withError } from "@/utils/middleware";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = withError("imap/poll", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(new Error("Unauthorized cron request: api/imap/poll"));
    return new Response("Unauthorized", { status: 401 });
  }

  const results = await pollImapAccounts(request.logger);

  return NextResponse.json({
    total: results.length,
    errors: results.filter((result) => result.status === "error").length,
  });
});
