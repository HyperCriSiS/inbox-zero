import { NextResponse } from "next/server";
import { hasCronSecret, hasPostCronSecret } from "@/utils/cron";
import { captureException } from "@/utils/error";
import { runLabelCleanups } from "@/utils/label-cleanup/run-label-cleanup";
import { type RequestWithLogger, withError } from "@/utils/middleware";

export const maxDuration = 300;

export const GET = withError("cron/label-cleanup", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(new Error("Unauthorized request: api/cron/label-cleanup"));
    return new Response("Unauthorized", { status: 401 });
  }

  return run(request);
});

export const POST = withError("cron/label-cleanup", async (request) => {
  if (!(await hasPostCronSecret(request))) {
    captureException(
      new Error("Unauthorized cron request: api/cron/label-cleanup"),
    );
    return new Response("Unauthorized", { status: 401 });
  }

  return run(request);
});

async function run(request: RequestWithLogger) {
  const results = await runLabelCleanups(request.logger);
  return NextResponse.json({ results });
}
