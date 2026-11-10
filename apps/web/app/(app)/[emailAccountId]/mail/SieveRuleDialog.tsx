"use client";

import { useEffect, useState } from "react";
import { useAction } from "next-safe-action/hooks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LoadingContent } from "@/components/LoadingContent";
import { toastError, toastSuccess } from "@/components/Toast";
import {
  applySieveRuleAction,
  planSieveRuleAction,
  suggestSieveRuleAction,
} from "@/utils/actions/sieve";
import type { PlanSieveRuleBody } from "@/utils/actions/sieve.validation";
import { getActionErrorMessage } from "@/utils/error";

export function SieveRuleDialog({
  emailAccountId,
  messageId,
  canApply,
  open,
  onOpenChange,
}: {
  emailAccountId: string;
  messageId: string;
  canApply: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Sieve rule from this mail</DialogTitle>
          <DialogDescription>
            Your Sieve server files mail like this into a folder from now on.
            Only the headers of this mail are sent to it.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <Content
            emailAccountId={emailAccountId}
            messageId={messageId}
            canApply={canApply}
            onSaved={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Content({
  emailAccountId,
  messageId,
  canApply,
  onSaved,
}: {
  emailAccountId: string;
  messageId: string;
  canApply: boolean;
  onSaved: () => void;
}) {
  const suggest = useAction(suggestSieveRuleAction.bind(null, emailAccountId));
  const plan = useAction(planSieveRuleAction.bind(null, emailAccountId), {
    onError: ({ error }) =>
      toastError({
        description: getActionErrorMessage(error, "Could not plan the rule."),
      }),
  });
  const apply = useAction(applySieveRuleAction.bind(null, emailAccountId), {
    onSuccess: ({ data }) => {
      toastSuccess({
        description: data?.saved
          ? `Saved to ${data.target}.`
          : (data?.reason ?? "Nothing to change."),
      });
      onSaved();
    },
    onError: ({ error }) =>
      toastError({
        description: getActionErrorMessage(error, "Could not save the rule."),
      }),
  });
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [combine, setCombine] = useState<PlanSieveRuleBody["combine"]>("anyof");
  const [folder, setFolder] = useState("");

  const { execute: loadSuggestions } = suggest;
  useEffect(() => {
    loadSuggestions({ messageId });
  }, [loadSuggestions, messageId]);

  const suggestions = suggest.result.data?.suggestions ?? [];
  const folders = suggest.result.data?.folders ?? [];
  // The mailing list, or else the sender, is what most filters key on.
  const selected = chosen ?? suggestions.slice(0, 1).map(({ id }) => id);
  const input: PlanSieveRuleBody = {
    messageId,
    combine,
    folder,
    conditions: suggestions
      .filter(({ id }) => selected.includes(id))
      .map(({ condition }) => condition),
  };
  const ready = input.conditions.length > 0 && !!folder;
  const preview = plan.result.data;

  return (
    <LoadingContent
      loading={!suggest.hasSucceeded && !suggest.hasErrored}
      error={
        suggest.hasErrored
          ? {
              error: getActionErrorMessage(
                suggest.result,
                "Could not reach the Sieve server.",
              ),
            }
          : undefined
      }
    >
      <div className="space-y-4 text-sm">
        <div className="space-y-2">
          <div className="font-medium">Match mail by</div>
          {suggestions.map(({ id, label }) => (
            <div key={id} className="flex items-center gap-2">
              <Checkbox
                id={`sieve-${id}`}
                checked={selected.includes(id)}
                onCheckedChange={(checked) => {
                  plan.reset();
                  setChosen(
                    checked === true
                      ? [...selected, id]
                      : selected.filter((item) => item !== id),
                  );
                }}
              />
              <label htmlFor={`sieve-${id}`}>{label}</label>
            </div>
          ))}
          {selected.length > 1 && (
            <Select
              value={combine}
              onValueChange={(value) => {
                plan.reset();
                setCombine(value as PlanSieveRuleBody["combine"]);
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anyof">Any of these</SelectItem>
                <SelectItem value="allof">All of these</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="space-y-2">
          <div className="font-medium">File into</div>
          <Select
            value={folder}
            onValueChange={(value) => {
              plan.reset();
              setFolder(value);
            }}
          >
            <SelectTrigger className="w-72">
              <SelectValue placeholder="Choose a folder" />
            </SelectTrigger>
            <SelectContent>
              {folders.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {preview && (
          <div className="space-y-2 rounded-md border p-3">
            <div>
              {preview.newFilter ? "New filter" : "Filter"}{" "}
              <span className="font-medium">{preview.target}</span>
              {preview.lands && (
                <> · this mail would end up in {preview.lands}</>
              )}
            </div>
            {[...preview.errors, ...preview.conflicts, ...preview.notes].map(
              (line) => (
                <p key={line} className="text-muted-foreground">
                  {line}
                </p>
              ),
            )}
            {preview.diff && (
              <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
                {preview.diff}
              </pre>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={!ready}
            loading={plan.isExecuting}
            onClick={() => plan.execute(input)}
          >
            Preview
          </Button>
          <Button
            disabled={
              !ready || !preview || preview.errors.length > 0 || !canApply
            }
            loading={apply.isExecuting}
            onClick={() => apply.execute(input)}
          >
            Save to server
          </Button>
        </div>
        {!canApply && (
          <p className="text-muted-foreground">
            To save, turn on the apply_rule tool of your Sieve server under
            Integrations.
          </p>
        )}
      </div>
    </LoadingContent>
  );
}
