"use client";

import { useState } from "react";
import useSWR from "swr";
import { useAction } from "next-safe-action/hooks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SettingCard } from "@/components/SettingCard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { LoadingContent } from "@/components/LoadingContent";
import { toastError, toastSuccess } from "@/components/Toast";
import { useAccount } from "@/providers/EmailAccountProvider";
import type { GetImapRuleFoldersResponse } from "@/app/api/user/imap-rule-folders/route";
import { saveImapRuleFoldersAction } from "@/utils/actions/imap-rule-folders";
import { isImapProvider } from "@/utils/email/provider-types";
import { getActionErrorMessage } from "@/utils/error";

export function ImapRuleFoldersSetting() {
  const { provider } = useAccount();
  const [open, setOpen] = useState(false);
  if (!isImapProvider(provider)) return null;

  return (
    <SettingCard
      title="Rules in other folders"
      description="Run your rules on new mail in folders other than the inbox, such as folders your server's filters (Sieve) sort mail into."
      right={
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              Configure
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Rules in other folders</DialogTitle>
              <DialogDescription>
                New mail in these folders runs your rules, as new mail in the
                inbox does. Mail that is already there is left alone.
              </DialogDescription>
            </DialogHeader>
            {open && <Content onSaved={() => setOpen(false)} />}
          </DialogContent>
        </Dialog>
      }
    />
  );
}

function Content({ onSaved }: { onSaved: () => void }) {
  const { emailAccountId } = useAccount();
  const { data, isLoading, error, mutate } = useSWR<GetImapRuleFoldersResponse>(
    "/api/user/imap-rule-folders",
  );
  const [edited, setEdited] = useState<string[] | null>(null);
  const selected = edited ?? data?.selected ?? [];

  const save = useAction(saveImapRuleFoldersAction.bind(null, emailAccountId), {
    onSuccess: () => {
      toastSuccess({ description: "Folders saved." });
      mutate();
      onSaved();
    },
    onError: ({ error }) =>
      toastError({
        description: getActionErrorMessage(
          error,
          "Could not save the folders.",
        ),
      }),
  });

  const toggle = (path: string, checked: boolean) =>
    setEdited(
      checked ? [...selected, path] : selected.filter((item) => item !== path),
    );

  return (
    <LoadingContent loading={isLoading} error={error}>
      {data && (
        <div className="space-y-4">
          {data.folders.length ? (
            <ul className="max-h-80 space-y-2 overflow-y-auto">
              {data.folders.map((path) => (
                <li key={path}>
                  <div className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={`rule-folder-${path}`}
                      checked={selected.includes(path)}
                      onCheckedChange={(checked) =>
                        toggle(path, checked === true)
                      }
                    />
                    <label htmlFor={`rule-folder-${path}`}>{path}</label>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">
              This mailbox has no folders of its own yet.
            </p>
          )}
          <Button
            loading={save.isExecuting}
            onClick={() => save.execute({ folders: selected })}
          >
            Save
          </Button>
        </div>
      )}
    </LoadingContent>
  );
}
