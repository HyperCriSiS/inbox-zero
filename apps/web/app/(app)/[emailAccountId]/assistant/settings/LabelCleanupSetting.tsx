"use client";

import { useState } from "react";
import useSWR from "swr";
import { useAction } from "next-safe-action/hooks";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingCard } from "@/components/SettingCard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LabelCombobox } from "@/components/LabelCombobox";
import { LoadingContent } from "@/components/LoadingContent";
import { toastError, toastSuccess } from "@/components/Toast";
import { useLabels } from "@/hooks/useLabels";
import { useAccount } from "@/providers/EmailAccountProvider";
import type { GetLabelCleanupsResponse } from "@/app/api/user/label-cleanup/route";
import {
  deleteLabelCleanupAction,
  saveLabelCleanupAction,
} from "@/utils/actions/label-cleanup";
import type { SaveLabelCleanupBody } from "@/utils/actions/label-cleanup.validation";
import { getActionErrorMessage } from "@/utils/error";

const ACTION_LABELS: Record<SaveLabelCleanupBody["action"], string> = {
  REMOVE_LABEL: "Remove the label",
  ARCHIVE: "Archive",
  TRASH: "Move to trash",
};

export function LabelCleanupSetting() {
  return (
    <SettingCard
      title="Label cleanup"
      description="Clear out mail under a label once it is old, so folders like Newsletters do not grow forever. Runs once a day."
      right={
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              Configure
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Label cleanup</DialogTitle>
              <DialogDescription>
                Once every message in a thread is older than the number of days,
                the action is applied. A reply restarts the clock. Up to 500
                threads per label are handled each day.
              </DialogDescription>
            </DialogHeader>
            <Content />
          </DialogContent>
        </Dialog>
      }
    />
  );
}

function Content() {
  const { emailAccountId } = useAccount();
  const { data, isLoading, error, mutate } = useSWR<GetLabelCleanupsResponse>(
    "/api/user/label-cleanup",
  );
  const labels = useLabels(emailAccountId);
  const [labelId, setLabelId] = useState<string | null>(null);
  const [afterDays, setAfterDays] = useState("30");
  const [action, setAction] =
    useState<SaveLabelCleanupBody["action"]>("ARCHIVE");

  const save = useAction(saveLabelCleanupAction.bind(null, emailAccountId), {
    onSuccess: () => {
      toastSuccess({ description: "Cleanup saved." });
      setLabelId(null);
      mutate();
    },
    onError: ({ error }) =>
      toastError({
        description: getActionErrorMessage(
          error,
          "Could not save the cleanup.",
        ),
      }),
  });
  const remove = useAction(
    deleteLabelCleanupAction.bind(null, emailAccountId),
    {
      onSuccess: () => mutate(),
      onError: ({ error }) =>
        toastError({
          description: getActionErrorMessage(error, "Could not remove it."),
        }),
    },
  );

  const selected = labels.userLabels.find((label) => label.id === labelId);

  return (
    <div className="space-y-6">
      <LoadingContent loading={isLoading} error={error}>
        {data?.cleanups.length ? (
          <ul className="divide-y rounded-md border">
            {data.cleanups.map((cleanup) => (
              <li
                key={cleanup.id}
                className="flex items-center justify-between gap-4 p-3 text-sm"
              >
                <div>
                  <div className="font-medium">{cleanup.labelName}</div>
                  <div className="text-muted-foreground">
                    {ACTION_LABELS[cleanup.action]} after {cleanup.afterDays}{" "}
                    {cleanup.afterDays === 1 ? "day" : "days"}
                    {cleanup.lastRunAt
                      ? ` · last run ${new Date(cleanup.lastRunAt).toLocaleDateString()}, ${cleanup.lastRunCount ?? 0} threads`
                      : " · not run yet"}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove cleanup for ${cleanup.labelName}`}
                  loading={remove.isExecuting}
                  onClick={() => remove.execute({ id: cleanup.id })}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No cleanups yet.</p>
        )}
      </LoadingContent>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        <LabelCombobox
          value={{ id: labelId, name: selected?.name ?? null }}
          onChangeValue={(label) => setLabelId(label.id)}
          userLabels={labels.userLabels}
          isLoading={labels.isLoading}
          mutate={labels.mutate}
          emailAccountId={emailAccountId}
        />
        <label className="flex items-center gap-2 text-sm">
          after
          <input
            type="number"
            min={1}
            max={3650}
            value={afterDays}
            onChange={(event) => setAfterDays(event.target.value)}
            className="h-9 w-20 rounded-md border bg-background px-2"
            aria-label="Days"
          />
          days
        </label>
        <Select
          value={action}
          onValueChange={(value) =>
            setAction(value as SaveLabelCleanupBody["action"])
          }
        >
          <SelectTrigger className="w-44" aria-label="Action">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(ACTION_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          loading={save.isExecuting}
          disabled={!selected}
          onClick={() =>
            selected &&
            save.execute({
              labelId: selected.id,
              labelName: selected.name,
              afterDays: Number(afterDays),
              action,
            })
          }
        >
          Add
        </Button>
      </div>
    </div>
  );
}
