import { SafeError } from "@/utils/error";
import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";
import type { CalendarEventProvider } from "@/utils/calendar/event-types";
import { GoogleCalendarEventProvider } from "@/utils/calendar/providers/google-events";
import { MicrosoftCalendarEventProvider } from "@/utils/calendar/providers/microsoft-events";
import { CalDavCalendarProvider } from "@/utils/calendar/providers/caldav";
import {
  isCalDavProvider,
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";

export const calendarConnectionProviderSelect = {
  id: true,
  provider: true,
  accessToken: true,
  refreshToken: true,
  expiresAt: true,
  email: true,
  caldavUrl: true,
  caldavUsername: true,
  caldavPassword: true,
} satisfies Prisma.CalendarConnectionSelect;

export type CalendarConnectionForProvider =
  Prisma.CalendarConnectionGetPayload<{
    select: typeof calendarConnectionProviderSelect;
  }>;

/**
 * Create calendar event providers for all connected calendars.
 * Fetches calendar connections once and creates providers that can be reused.
 */
export async function createCalendarEventProviders(
  emailAccountId: string,
  logger: Logger,
): Promise<CalendarEventProvider[]> {
  const connections = await getConnectedCalendarConnections(emailAccountId);

  return createCalendarEventProvidersFromConnections({
    connections,
    emailAccountId,
    logger,
  });
}

export function getConnectedCalendarConnections(
  emailAccountId: string,
): Promise<CalendarConnectionForProvider[]> {
  return prisma.calendarConnection.findMany({
    where: {
      emailAccountId,
      isConnected: true,
    },
    select: calendarConnectionProviderSelect,
  });
}

export function createCalendarEventProvidersFromConnections({
  connections,
  emailAccountId,
  logger,
}: {
  connections: CalendarConnectionForProvider[];
  emailAccountId: string;
  logger: Logger;
}): CalendarEventProvider[] {
  if (connections.length === 0) {
    logger.info("No calendar connections found", { emailAccountId });
    return [];
  }

  const providers: CalendarEventProvider[] = [];

  for (const connection of connections) {
    if (!isUsableCalendarConnection(connection)) continue;

    try {
      providers.push(
        isCalDavProvider(connection.provider)
          ? createCalDavEventProvider(connection, emailAccountId)
          : createCalendarEventProvider({ connection, emailAccountId, logger }),
      );
    } catch (error) {
      logger.error("Failed to create calendar event provider", {
        provider: connection.provider,
        error,
      });
    }
  }

  return providers;
}

// Same connections createCalendarEventProviders can use. A missing refresh
// token or unknown provider builds no provider, so the chat tool would fail.
export async function hasUsableCalendarConnection(emailAccountId: string) {
  const connections = await prisma.calendarConnection.findMany({
    where: {
      emailAccountId,
      isConnected: true,
    },
    select: {
      provider: true,
      refreshToken: true,
      caldavUrl: true,
      caldavPassword: true,
    },
  });

  return connections.some(isUsableCalendarConnection);
}

export function createCalendarEventProvider({
  connection,
  emailAccountId,
  logger,
}: {
  connection: {
    accessToken: string | null;
    expiresAt: Date | null;
    id: string;
    provider: string;
    refreshToken: string | null;
  };
  emailAccountId: string;
  logger: Logger;
}) {
  const providerParams = {
    accessToken: connection.accessToken,
    connectionId: connection.id,
    refreshToken: connection.refreshToken,
    expiresAt: connection.expiresAt?.getTime() ?? null,
    emailAccountId,
  };

  if (isGoogleProvider(connection.provider)) {
    return new GoogleCalendarEventProvider(providerParams, logger);
  }

  if (isMicrosoftProvider(connection.provider)) {
    return new MicrosoftCalendarEventProvider(providerParams, logger);
  }

  throw new SafeError("Unsupported calendar provider");
}

function isUsableCalendarConnection(connection: {
  provider: string;
  refreshToken: string | null;
  caldavUrl?: string | null;
  caldavPassword?: string | null;
}) {
  if (isCalDavProvider(connection.provider)) {
    return !!connection.caldavUrl && !!connection.caldavPassword;
  }
  if (!connection.refreshToken) return false;

  return (
    isGoogleProvider(connection.provider) ||
    isMicrosoftProvider(connection.provider)
  );
}

// CalDAV calendars are read for context and free/busy only, so they get no
// writer and stay out of createCalendarEventProvider.
function createCalDavEventProvider(
  connection: CalendarConnectionForProvider,
  emailAccountId: string,
) {
  if (!connection.caldavUrl || !connection.caldavPassword) {
    throw new SafeError("CalDAV connection is missing its server or password");
  }
  return new CalDavCalendarProvider({
    serverUrl: connection.caldavUrl,
    username: connection.caldavUsername ?? connection.email,
    password: connection.caldavPassword,
    email: connection.email,
    connectionId: connection.id,
    emailAccountId,
  });
}
