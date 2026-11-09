"use server";

import { actionClient } from "@/utils/actions/safe-action";
import {
  disconnectCalendarBody,
  toggleCalendarBody,
  updateTimezoneBody,
  updateBookingLinkBody,
  connectCalDavCalendarBody,
} from "@/utils/actions/calendar.validation";
import prisma from "@/utils/prisma";
import { SafeError } from "@/utils/error";
import { connectCalDavCalendar } from "@/utils/calendar/caldav-connect";

export const disconnectCalendarAction = actionClient
  .metadata({ name: "disconnectCalendar" })
  .inputSchema(disconnectCalendarBody)
  .action(
    async ({ ctx: { emailAccountId }, parsedInput: { connectionId } }) => {
      const connection = await prisma.calendarConnection.findFirst({
        where: {
          id: connectionId,
          emailAccountId,
        },
      });

      if (!connection) {
        throw new SafeError("Calendar connection not found");
      }

      await prisma.calendarConnection.delete({
        where: { id: connectionId },
      });

      return { success: true };
    },
  );

export const toggleCalendarAction = actionClient
  .metadata({ name: "toggleCalendar" })
  .inputSchema(toggleCalendarBody)
  .action(
    async ({
      ctx: { emailAccountId },
      parsedInput: { calendarId, isEnabled },
    }) => {
      const updatedCalendar = await prisma.calendar.updateMany({
        where: {
          id: calendarId,
          connection: {
            emailAccountId,
          },
        },
        data: { isEnabled },
      });

      if (updatedCalendar.count === 0) {
        throw new SafeError("Calendar not found");
      }

      return { success: true };
    },
  );

export const updateEmailAccountTimezoneAction = actionClient
  .metadata({ name: "updateTimezone" })
  .inputSchema(updateTimezoneBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { timezone } }) => {
    await prisma.emailAccount.update({
      where: { id: emailAccountId },
      data: { timezone },
    });
  });

export const fillMissingTimezoneAction = actionClient
  .metadata({ name: "fillMissingTimezone" })
  .inputSchema(updateTimezoneBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { timezone } }) => {
    const result = await prisma.emailAccount.updateMany({
      where: { id: emailAccountId, timezone: null },
      data: { timezone },
    });
    return { updated: result.count > 0 };
  });

export const updateCalendarBookingLinkAction = actionClient
  .metadata({ name: "updateBookingLink" })
  .inputSchema(updateBookingLinkBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { bookingLink } }) => {
    await prisma.emailAccount.update({
      where: { id: emailAccountId },
      data: { calendarBookingLink: bookingLink || null },
    });
  });

export const connectCalDavCalendarAction = actionClient
  .metadata({ name: "connectCalDavCalendar" })
  .inputSchema(connectCalDavCalendarBody)
  .action(async ({ ctx: { emailAccountId, logger }, parsedInput }) =>
    connectCalDavCalendar({ emailAccountId, logger, ...parsedInput }),
  );
