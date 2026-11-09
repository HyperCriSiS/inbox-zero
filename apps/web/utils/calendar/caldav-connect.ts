import type { ConnectCalDavCalendarBody } from "@/utils/actions/calendar.validation";
import {
  discoverCalDavCalendars,
  getCalDavUrlError,
} from "@/utils/calendar/providers/caldav";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

/**
 * Checks the credentials by listing the calendars, then stores the connection
 * and its calendars. Linking the same account again updates the password and
 * the calendar list.
 */
export async function connectCalDavCalendar({
  emailAccountId,
  serverUrl,
  username,
  password,
  email,
  logger,
}: ConnectCalDavCalendarBody & { emailAccountId: string; logger: Logger }) {
  const urlError = getCalDavUrlError(serverUrl);
  if (urlError) throw new SafeError(urlError);

  let calendars: Awaited<ReturnType<typeof discoverCalDavCalendars>>;
  try {
    calendars = await discoverCalDavCalendars({
      serverUrl,
      username,
      password,
    });
  } catch (error) {
    logger.warn("CalDAV discovery failed", { error });
    throw new SafeError(
      "Could not reach the calendar. Check the server URL, user name and password.",
    );
  }
  if (!calendars.length) {
    throw new SafeError("No calendars found for this account.");
  }

  const account = await prisma.emailAccount.findUniqueOrThrow({
    where: { id: emailAccountId },
    select: { email: true },
  });
  // The address the calendar uses in invitations, for "am I invited".
  const connectionEmail = (
    email || (username.includes("@") ? username : account.email)
  ).toLowerCase();

  const connection = await prisma.calendarConnection.upsert({
    where: {
      emailAccountId_provider_email: {
        emailAccountId,
        provider: "caldav",
        email: connectionEmail,
      },
    },
    create: {
      emailAccountId,
      provider: "caldav",
      email: connectionEmail,
      caldavUrl: serverUrl,
      caldavUsername: username,
      caldavPassword: password,
    },
    update: {
      caldavUrl: serverUrl,
      caldavUsername: username,
      caldavPassword: password,
      isConnected: true,
    },
    select: { id: true },
  });

  const calendarIds = calendars.map((calendar) => calendar.calendarId);
  await prisma.$transaction([
    // Calendars gone from the server stop counting for availability.
    prisma.calendar.updateMany({
      where: {
        connectionId: connection.id,
        calendarId: { notIn: calendarIds },
      },
      data: { isEnabled: false },
    }),
    ...calendars.map((calendar) =>
      prisma.calendar.upsert({
        where: {
          connectionId_calendarId: {
            connectionId: connection.id,
            calendarId: calendar.calendarId,
          },
        },
        create: { ...calendar, connectionId: connection.id },
        update: {
          name: calendar.name,
          description: calendar.description,
          timezone: calendar.timezone,
          isReadOnly: calendar.isReadOnly,
        },
      }),
    ),
  ]);

  return {
    success: true,
    connectionId: connection.id,
    calendarCount: calendars.length,
  };
}
