"use client";

import { useState } from "react";
import { useAction } from "next-safe-action/hooks";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/Input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useCalendars } from "@/hooks/useCalendars";
import { connectCalDavCalendarAction } from "@/utils/actions/calendar";
import {
  type ConnectCalDavCalendarBody,
  connectCalDavCalendarBody,
} from "@/utils/actions/calendar.validation";
import { getActionErrorMessage } from "@/utils/error";
import { toastError, toastSuccess } from "@/components/Toast";

export function CalDavCalendarForm({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const { emailAccountId, userEmail } = useAccount();
  const { mutate } = useCalendars();
  const form = useForm<ConnectCalDavCalendarBody>({
    resolver: zodResolver(connectCalDavCalendarBody),
    defaultValues: {
      serverUrl: "",
      username: userEmail,
      password: "",
      email: userEmail,
    },
  });
  const { execute, isExecuting } = useAction(
    connectCalDavCalendarAction.bind(null, emailAccountId),
    {
      onSuccess: ({ data }) => {
        form.reset({ ...form.getValues(), password: "" });
        setOpen(false);
        mutate();
        toastSuccess({
          description: `Connected ${data?.calendarCount ?? 0} calendar(s).`,
        });
      },
      onError: ({ error }) =>
        toastError({
          description:
            getActionErrorMessage(error) ?? "Could not connect the calendar.",
        }),
    },
  );

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="flex items-center gap-2 w-full md:w-auto"
      >
        <CalendarIcon className="size-4" />
        Add CalDAV Calendar
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect a CalDAV calendar</DialogTitle>
            <DialogDescription>
              Works with Nextcloud, iCloud, Fastmail, mailbox.org, Radicale and
              other CalDAV servers. Use an app password where your provider
              offers one. Calendars are read for meeting context and
              availability; events are not created here.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={form.handleSubmit(execute)}>
            <Input
              name="serverUrl"
              type="url"
              label="Server URL"
              placeholder="https://cloud.example.com/remote.php/dav"
              registerProps={form.register("serverUrl")}
              error={form.formState.errors.serverUrl}
            />
            <Input
              name="username"
              type="text"
              label="User name"
              registerProps={{
                ...form.register("username"),
                autoComplete: "username",
              }}
              error={form.formState.errors.username}
            />
            <Input
              name="password"
              type="password"
              label="Password or app password"
              registerProps={{
                ...form.register("password"),
                autoComplete: "new-password",
              }}
              error={form.formState.errors.password}
            />
            <Input
              name="email"
              type="email"
              label="Email address in invitations"
              explainText="Used to tell which events you organize or declined."
              registerProps={form.register("email")}
              error={form.formState.errors.email}
            />
            <Button type="submit" loading={isExecuting}>
              Connect calendar
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
