"use client";

import { useState } from "react";
import { useAction } from "next-safe-action/hooks";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/components/Toast";
import { linkImapAccountAction } from "@/utils/actions/imap";
import type { LinkImapAccountBody } from "@/utils/actions/imap.validation";
import { getActionErrorMessage } from "@/utils/error";
import { EMAIL_ACCOUNTS_KEY } from "@/utils/fetch-email-accounts";
import { IMAP_PRESETS } from "@/utils/imap/presets";

const INITIAL_VALUES: LinkImapAccountBody = {
  email: "",
  name: "",
  imapHost: "",
  imapPort: 993,
  imapSecurity: "tls",
  smtpHost: "",
  smtpPort: 587,
  smtpSecurity: "starttls",
  username: "",
  password: "",
  tlsPinnedCertPem: "",
};

export function AddImapAccount() {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(INITIAL_VALUES);

  const { execute, isExecuting } = useAction(linkImapAccountAction, {
    onSuccess: () => {
      toastSuccess({ description: "Mail account linked" });
      setOpen(false);
      setValues(INITIAL_VALUES);
      mutate(EMAIL_ACCOUNTS_KEY);
      // The connect-mailbox page redirects from the server once an account exists.
      router.refresh();
    },
    onError: (error) => {
      toastError({
        title: "Could not link the account",
        description: getActionErrorMessage(error.error),
      });
    },
  });

  const update = (patch: Partial<LinkImapAccountBody>) =>
    setValues((current) => ({ ...current, ...patch }));

  const text = (key: keyof LinkImapAccountBody, placeholder: string) => (
    <Input
      name={key}
      placeholder={placeholder}
      aria-label={placeholder}
      value={String(values[key] ?? "")}
      onChange={(event) => update({ [key]: event.target.value })}
    />
  );

  const serverFields = (prefix: "imap" | "smtp", label: string) => (
    <div className="flex gap-2">
      {text(`${prefix}Host`, `${label} server`)}
      <Input
        className="w-28 shrink-0"
        type="number"
        min={1}
        max={65_535}
        aria-label={`${label} port`}
        value={values[`${prefix}Port`]}
        onChange={(event) =>
          update({ [`${prefix}Port`]: Number(event.target.value) })
        }
      />
      <select
        aria-label={`${label} security`}
        className="h-9 rounded-md border bg-background px-2 text-sm"
        value={values[`${prefix}Security`]}
        onChange={(event) =>
          update({
            [`${prefix}Security`]: event.target
              .value as LinkImapAccountBody["imapSecurity"],
          })
        }
      >
        <option value="tls">TLS</option>
        <option value="starttls">STARTTLS</option>
        <option value="none">None</option>
      </select>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Add other mail account (IMAP)</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an IMAP account</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            execute({
              ...values,
              username: values.username || values.email,
              tlsPinnedCertPem: values.tlsPinnedCertPem || undefined,
            });
          }}
        >
          <select
            aria-label="Mail provider"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            defaultValue=""
            onChange={(event) => {
              const preset = IMAP_PRESETS.find(
                (item) => item.name === event.target.value,
              );
              if (!preset) return;
              const { name: _name, ...settings } = preset;
              update(settings);
            }}
          >
            <option value="">Choose a provider or enter settings</option>
            {IMAP_PRESETS.map((preset) => (
              <option key={preset.name} value={preset.name}>
                {preset.name}
              </option>
            ))}
          </select>
          {text("email", "Email address")}
          {text("username", "Username (defaults to email)")}
          <Input
            name="password"
            type="password"
            placeholder="Password or app password"
            aria-label="Password or app password"
            autoComplete="off"
            value={values.password}
            onChange={(event) => update({ password: event.target.value })}
          />
          {serverFields("imap", "IMAP")}
          {serverFields("smtp", "SMTP")}
          <textarea
            aria-label="Pinned certificate (only for self-signed servers)"
            placeholder="Pinned certificate in PEM format (only for self-signed servers such as Proton Mail Bridge)"
            className="min-h-16 rounded-md border bg-background p-2 text-xs"
            value={values.tlsPinnedCertPem ?? ""}
            onChange={(event) =>
              update({ tlsPinnedCertPem: event.target.value })
            }
          />
          <Button type="submit" disabled={isExecuting}>
            {isExecuting ? "Checking connection..." : "Link account"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
