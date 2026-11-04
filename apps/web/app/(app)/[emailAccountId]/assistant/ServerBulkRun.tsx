"use client";

import useSWR from "swr";
import { useAction } from "next-safe-action/hooks";
import { PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toastError } from "@/components/Toast";
import type { GetBulkRuleRunResponse } from "@/app/api/user/bulk-rule-run/route";
import {
  cancelBulkRuleRunAction,
  pauseBulkRuleRunAction,
  resumeBulkRuleRunAction,
  startBulkRuleRunAction,
} from "@/utils/actions/bulk-rule-run";
import { getActionErrorMessage } from "@/utils/error";

const STATUS_TEXT = {
  RUNNING: "Running on the server",
  PAUSED: "Paused",
  COMPLETED: "Finished",
  CANCELLED: "Stopped",
  FAILED: "Failed",
} as const;

/**
 * Bulk processing driven by a background job, so it keeps going with the tab
 * closed. Progress is read from the server every few seconds.
 */
export function ServerBulkRun({
  emailAccountId,
  startDate,
  endDate,
  includeRead,
  rerun,
  generateDraftReplies,
  disabled,
}: {
  emailAccountId: string;
  startDate?: Date;
  endDate?: Date;
  includeRead: boolean;
  rerun: boolean;
  generateDraftReplies: boolean;
  disabled: boolean;
}) {
  const { data, mutate } = useSWR<GetBulkRuleRunResponse>(
    "/api/user/bulk-rule-run",
    {
      refreshInterval: (latest) =>
        latest?.run?.status === "RUNNING" ? 5000 : 0,
    },
  );
  const run = data?.run;
  const active = run?.status === "RUNNING" || run?.status === "PAUSED";

  const onError = ({
    error,
  }: {
    error: Parameters<typeof getActionErrorMessage>[0];
  }) => toastError({ description: getActionErrorMessage(error) });
  const start = useAction(startBulkRuleRunAction.bind(null, emailAccountId), {
    onSuccess: () => mutate(),
    onError,
  });
  const pause = useAction(pauseBulkRuleRunAction.bind(null, emailAccountId), {
    onSuccess: () => mutate(),
    onError,
  });
  const resume = useAction(resumeBulkRuleRunAction.bind(null, emailAccountId), {
    onSuccess: () => mutate(),
    onError,
  });
  const cancel = useAction(cancelBulkRuleRunAction.bind(null, emailAccountId), {
    onSuccess: () => mutate(),
    onError,
  });

  return (
    <div className="space-y-3">
      {run && (
        <div className="rounded-md border px-3 py-2 text-sm">
          <div className="font-medium">{STATUS_TEXT[run.status]}</div>
          <div className="text-muted-foreground">
            {run.processed} processed · {run.skipped} already done ·{" "}
            {run.failed} failed
            {run.lastError ? ` · ${run.lastError}` : ""}
          </div>
        </div>
      )}

      {active && run ? (
        <div className="flex justify-end gap-2">
          {run.status === "RUNNING" ? (
            <Button
              size="sm"
              loading={pause.isExecuting}
              onClick={() => pause.execute({ runId: run.id })}
            >
              <PauseIcon className="mr-1.5 h-3.5 w-3.5" />
              Pause
            </Button>
          ) : (
            <Button
              size="sm"
              loading={resume.isExecuting}
              onClick={() => resume.execute({ runId: run.id })}
            >
              <PlayIcon className="mr-1.5 h-3.5 w-3.5" />
              Resume
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            loading={cancel.isExecuting}
            onClick={() => cancel.execute({ runId: run.id })}
          >
            <SquareIcon className="mr-1.5 h-3.5 w-3.5" />
            Stop
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          disabled={disabled || !startDate}
          loading={start.isExecuting}
          onClick={() =>
            startDate &&
            start.execute({
              startDate,
              endDate: endDate ?? null,
              includeRead,
              rerun,
              generateDraftReplies,
            })
          }
        >
          Process Emails in the Background
        </Button>
      )}
    </div>
  );
}
