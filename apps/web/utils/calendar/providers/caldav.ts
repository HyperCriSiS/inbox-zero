import { randomUUID } from "node:crypto";
import { TZDate } from "@date-fns/tz";
import ICAL from "ical.js";
import {
  createDAVClient,
  type DAVCalendar,
  type DAVCalendarObject,
} from "tsdav";
import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici";
import { isSafeExternalHttpUrl } from "@inboxzero/network/safe-url";
import { env } from "@/env";
import type { BusyPeriod } from "@/utils/calendar/availability-types";
import type {
  CalendarEvent,
  CalendarEventCancelInput,
  CalendarEventProvider,
  CalendarEventUpdateInput,
  CalendarEventWriteInput,
  CalendarEventWriteResult,
} from "@/utils/calendar/event-types";
import type {
  CalendarInvitation,
  InvitationEvent,
  InvitationResponse,
} from "@/utils/calendar/invitations/parser";
import { findVideoConferenceLink } from "@/utils/calendar/video-conference-link";
import { SafeError } from "@/utils/error";
import { createSafeLookup } from "@/utils/mcp/safe-fetch";
import prisma from "@/utils/prisma";
import { z } from "zod";

export type CalDavCredentials = {
  serverUrl: string;
  username: string;
  password: string;
};

type CalDavConnection = CalDavCredentials & {
  connectionId: string;
  emailAccountId: string;
  // The address the calendar knows the user by, for organizer and RSVP checks.
  email: string;
};

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_OBJECT_SIZE = 5_000_000;
const MAX_OCCURRENCES = 100_000;
const DAY_MS = 86_400_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const publicOnlyAgent = new Agent({
  connect: { lookup: createSafeLookup(() => false) },
});

/**
 * Same policy as IMAP: private and internal servers need
 * IMAP_ALLOW_PRIVATE_HOSTS, and plain http needs IMAP_ALLOW_PLAINTEXT.
 * Returns why the URL is refused, if it is.
 */
export function getCalDavUrlError(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Enter the full server URL, starting with https://";
  }
  if (parsed.username || parsed.password) {
    return "Enter the user name and password in their own fields";
  }
  if (parsed.protocol === "http:") {
    if (!env.IMAP_ALLOW_PLAINTEXT) return "The server URL must use https";
  } else if (parsed.protocol !== "https:") {
    return "The server URL must use https";
  }
  if (env.IMAP_ALLOW_PRIVATE_HOSTS) return null;
  if (!isSafeExternalHttpUrl(url)) {
    return "Private and internal server addresses are not allowed";
  }
  return null;
}

/**
 * Every hop is checked against the URL policy, and without
 * IMAP_ALLOW_PRIVATE_HOSTS connections are pinned to addresses that passed the
 * SSRF guard. Redirects are followed by hand so each target is checked too,
 * unless the caller asked to see them, as service discovery does for
 * /.well-known/caldav. Its next request comes through here again.
 */
export const calDavFetch: typeof fetch = async (input, init) => {
  let target =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const urlError = getCalDavUrlError(target);
    if (urlError) throw new SafeError(`Calendar server refused: ${urlError}`);

    const response = await undiciFetch(target, {
      ...(init as UndiciRequestInit),
      redirect: "manual",
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(env.IMAP_ALLOW_PRIVATE_HOSTS ? {} : { dispatcher: publicOnlyAgent }),
    });

    if (
      !REDIRECT_STATUSES.has(response.status) ||
      init?.redirect === "manual"
    ) {
      return response as unknown as Response;
    }
    const location = response.headers.get("location");
    if (!location) return response as unknown as Response;
    target = new URL(location, target).href;
  }

  throw new SafeError("The calendar server redirected too many times");
};

export function createCalDavClient(credentials: CalDavCredentials) {
  return createDAVClient({
    serverUrl: credentials.serverUrl,
    credentials: {
      username: credentials.username,
      password: credentials.password,
    },
    authMethod: "Basic",
    defaultAccountType: "caldav",
    fetch: calDavFetch,
  });
}

export async function discoverCalDavCalendars(credentials: CalDavCredentials) {
  const client = await createCalDavClient(credentials);
  const calendars = await client.fetchCalendars({
    props: {
      "d:displayname": {},
      "c:calendar-description": {},
      "c:calendar-timezone": {},
      "c:supported-calendar-component-set": {},
      "d:resourcetype": {},
      "d:current-user-privilege-set": {},
    },
    projectedProps: { currentUserPrivilegeSet: true },
  });

  return calendars
    .filter(
      (calendar) =>
        !calendar.components || calendar.components.includes("VEVENT"),
    )
    .map((calendar, index) => ({
      calendarId: calendar.url,
      name:
        typeof calendar.displayName === "string" && calendar.displayName
          ? calendar.displayName
          : `Calendar ${index + 1}`,
      description:
        typeof calendar.description === "string" ? calendar.description : null,
      timezone: calendarTimezone(calendar),
      primary: index === 0,
      // Servers that leave out the privilege set are treated as writable;
      // a refused write still fails with a clear message.
      isReadOnly:
        calendar.projectedProps?.currentUserPrivilegeSet !== undefined &&
        !hasWritePrivilege(calendar.projectedProps.currentUserPrivilegeSet),
    }));
}

export class CalDavCalendarProvider implements CalendarEventProvider {
  private readonly connection: CalDavConnection;

  constructor(connection: CalDavConnection) {
    this.connection = connection;
  }

  async fetchEvents({
    timeMin = new Date(),
    timeMax = new Date(timeMin.getTime() + 90 * DAY_MS),
    maxResults = 100,
  }: {
    timeMin?: Date;
    timeMax?: Date;
    maxResults?: number;
  } = {}): Promise<CalendarEvent[]> {
    return sortAndLimit(
      (await this.readEvents(timeMin, timeMax)).map((item) => item.event),
      maxResults,
    );
  }

  async fetchEventsWithAttendee({
    attendeeEmail,
    timeMin,
    timeMax,
    maxResults,
  }: {
    attendeeEmail: string;
    timeMin: Date;
    timeMax: Date;
    maxResults: number;
  }): Promise<CalendarEvent[]> {
    const wanted = attendeeEmail.toLowerCase();
    return sortAndLimit(
      (await this.readEvents(timeMin, timeMax))
        .map((item) => item.event)
        .filter((event) =>
          event.attendees.some((attendee) => attendee.email === wanted),
        ),
      maxResults,
    );
  }

  async fetchBusyPeriods(timeMin: Date, timeMax: Date): Promise<BusyPeriod[]> {
    return (await this.readEvents(timeMin, timeMax))
      .filter((item) => item.busy)
      .map(({ event }) => ({
        start: event.startTime.toISOString(),
        end: event.endTime.toISOString(),
      }));
  }

  async createEvent(
    input: CalendarEventWriteInput,
  ): Promise<CalendarEventWriteResult> {
    if (
      input.locationType === "GOOGLE_MEET" ||
      input.locationType === "MICROSOFT_TEAMS"
    ) {
      throw new SafeError(
        "CalDAV calendars cannot create a video meeting. Choose a custom link, phone or place.",
      );
    }
    const { client, calendarUrl } = await this.getWritableCalendar(
      input.calendarId,
    );

    const uid = randomUUID();
    const calendar = new ICAL.Component("vcalendar");
    calendar.addPropertyWithValue("version", "2.0");
    calendar.addPropertyWithValue("prodid", "-//Inbox Zero//CalDAV//EN");
    const event = new ICAL.Component("vevent");
    event.addPropertyWithValue("uid", uid);
    event.addPropertyWithValue("sequence", 0);
    event.addPropertyWithValue(
      "dtstamp",
      ICAL.Time.fromJSDate(new Date(), true),
    );
    event.addPropertyWithValue(
      "dtstart",
      ICAL.Time.fromJSDate(input.startTime, true),
    );
    event.addPropertyWithValue(
      "dtend",
      ICAL.Time.fromJSDate(input.endTime, true),
    );
    event.addPropertyWithValue("summary", input.title);
    if (input.description) {
      event.addPropertyWithValue("description", input.description);
    }
    if (input.locationValue) {
      event.addPropertyWithValue("location", input.locationValue);
    }
    event.addPropertyWithValue("organizer", `mailto:${this.connection.email}`);
    for (const attendee of input.attendees) {
      const property = new ICAL.Property("attendee");
      property.setValue(`mailto:${attendee.email}`);
      if (attendee.name) property.setParameter("cn", attendee.name);
      property.setParameter("partstat", "NEEDS-ACTION");
      property.setParameter("rsvp", "TRUE");
      event.addProperty(property);
    }
    calendar.addSubcomponent(event);

    const filename = `${uid}.ics`;
    checkResponse(
      await client.createCalendarObject({
        calendar: { url: calendarUrl } as DAVCalendar,
        filename,
        iCalString: calendar.toString(),
        headers: { "If-None-Match": "*" },
      }),
    );

    return {
      id: encodeEventId(new URL(filename, withSlash(calendarUrl)).href, event),
      providerCalendarId: calendarUrl,
      videoConferenceLink: findVideoConferenceLink(input.locationValue),
    };
  }

  async updateEvent(input: CalendarEventUpdateInput): Promise<void> {
    const { client, object, calendar, event } = await this.readObject(
      input.calendarId,
      input.eventId,
    );
    this.assertOrganizer(event);
    event.updatePropertyWithValue(
      "dtstart",
      ICAL.Time.fromJSDate(input.startTime, true),
    );
    event.removeAllProperties("duration");
    event.updatePropertyWithValue(
      "dtend",
      ICAL.Time.fromJSDate(input.endTime, true),
    );
    bumpSequence(event);
    checkResponse(
      await client.updateCalendarObject({
        calendarObject: { ...object, data: calendar.toString() },
      }),
    );
  }

  async cancelEvent(input: CalendarEventCancelInput): Promise<void> {
    const { client, object, calendar, event } = await this.readObject(
      input.calendarId,
      input.eventId,
    );
    this.assertOrganizer(event);
    if (event.hasProperty("recurrence-id")) {
      // Deleting the object would remove the whole series.
      event.updatePropertyWithValue("status", "CANCELLED");
      bumpSequence(event);
      checkResponse(
        await client.updateCalendarObject({
          calendarObject: { ...object, data: calendar.toString() },
        }),
      );
      return;
    }
    checkResponse(
      await client.deleteCalendarObject({ calendarObject: object }),
    );
  }

  async findInvitationEvent(
    invitation: CalendarInvitation,
  ): Promise<InvitationEvent | null> {
    const client = await createCalDavClient(this.connection);
    const matches: InvitationEvent[] = [];

    for (const { calendarId } of await this.enabledCalendars()) {
      const objects = await client.fetchCalendarObjects({
        calendar: { url: calendarId },
        filters: [
          {
            "comp-filter": {
              _attributes: { name: "VCALENDAR" },
              "comp-filter": {
                _attributes: { name: "VEVENT" },
                "prop-filter": {
                  _attributes: { name: "UID" },
                  "text-match": {
                    _attributes: { collation: "i;octet" },
                    _text: invitation.uid,
                  },
                },
              },
            },
          },
        ],
      });

      for (const object of objects) {
        if (!isObjectInCalendar(calendarId, object.url)) continue;
        const calendar = parseCalendarObject(object);
        for (const event of calendar.getAllSubcomponents("vevent")) {
          if (
            event.getFirstPropertyValue("uid") !== invitation.uid ||
            recurrenceIdOf(event) !== invitation.recurrenceId ||
            emailValue(event.getFirstPropertyValue("organizer")) !==
              invitation.organizer.toLowerCase()
          ) {
            continue;
          }
          const attendee = findAttendee(event, invitation.attendee);
          if (!attendee) continue;
          if (
            Number(event.getFirstPropertyValue("sequence") ?? 0) !==
            invitation.sequence
          ) {
            throw new SafeError(
              "This invitation has changed. Open the latest invitation.",
            );
          }
          matches.push({
            id: encodeEventId(object.url, event),
            response:
              attendee.getParameter("partstat")?.toString().toLowerCase() ??
              null,
          });
        }
      }
    }

    if (matches.length > 1) {
      throw new SafeError(
        "This invitation matches several calendars. Respond from your calendar app.",
      );
    }
    return matches[0] ?? null;
  }

  /**
   * Sets the answer on the event in the calendar. Not every CalDAV server
   * tells the organizer, so the caller also sends the iCalendar reply by mail.
   */
  async respondToInvitation(
    eventId: string,
    invitation: CalendarInvitation,
    response: InvitationResponse,
  ): Promise<{ organizerNotified: false }> {
    if (
      invitation.attendee.toLowerCase() !== this.connection.email.toLowerCase()
    ) {
      throw new SafeError(
        "This invitation belongs to another calendar account.",
      );
    }
    const identity = decodeEventId(eventId);
    const calendar = (await this.enabledCalendars()).find(({ calendarId }) =>
      isObjectInCalendar(calendarId, identity.url),
    );
    if (!calendar) throw new SafeError("Calendar event not found");

    const {
      client,
      object,
      calendar: component,
      event,
    } = await this.readObject(calendar.calendarId, eventId);
    if (
      identity.uid !== invitation.uid ||
      recurrenceIdOf(event) !== invitation.recurrenceId ||
      emailValue(event.getFirstPropertyValue("organizer")) !==
        invitation.organizer.toLowerCase() ||
      Number(event.getFirstPropertyValue("sequence") ?? 0) !==
        invitation.sequence
    ) {
      throw new SafeError(
        "This invitation has changed. Open the latest invitation.",
      );
    }
    const attendee = findAttendee(event, invitation.attendee);
    if (!attendee) {
      throw new SafeError(
        "This invitation belongs to another calendar account.",
      );
    }
    attendee.setParameter("partstat", response.toUpperCase());
    attendee.setParameter("rsvp", "FALSE");
    checkResponse(
      await client.updateCalendarObject({
        calendarObject: { ...object, data: component.toString() },
      }),
    );
    return { organizerNotified: false };
  }

  private enabledCalendars() {
    return prisma.calendar.findMany({
      where: {
        connectionId: this.connection.connectionId,
        isEnabled: true,
        connection: {
          emailAccountId: this.connection.emailAccountId,
          isConnected: true,
        },
      },
      select: { calendarId: true, timezone: true, isReadOnly: true },
    });
  }

  private async getWritableCalendar(calendarUrl: string) {
    const calendar = (await this.enabledCalendars()).find(
      (entry) => entry.calendarId === calendarUrl,
    );
    if (!calendar) throw new SafeError("Calendar is unavailable or disabled.");
    if (calendar.isReadOnly) throw new SafeError("This calendar is read-only.");
    return { client: await createCalDavClient(this.connection), calendarUrl };
  }

  private async readObject(calendarUrl: string, eventId: string) {
    const identity = decodeEventId(eventId);
    if (!isObjectInCalendar(calendarUrl, identity.url)) {
      throw new SafeError("Event does not belong to this calendar.");
    }
    const { client } = await this.getWritableCalendar(calendarUrl);
    const objects = await client.fetchCalendarObjects({
      calendar: { url: calendarUrl },
      objectUrls: [identity.url],
    });
    const object = objects.find(
      (item) =>
        new URL(item.url, calendarUrl).href === new URL(identity.url).href,
    );
    if (!object) throw new SafeError("Calendar event not found.");
    const calendar = parseCalendarObject(object);
    const event = findOrDetachOccurrence(
      calendar,
      identity.uid,
      identity.recurrenceId,
    );
    if (!event) {
      throw new SafeError(
        "This occurrence changed. Open it in your calendar app.",
      );
    }
    return { client, object, calendar, event };
  }

  private assertOrganizer(event: ICAL.Component) {
    if (
      emailValue(event.getFirstPropertyValue("organizer")) !==
      this.connection.email.toLowerCase()
    ) {
      throw new SafeError("Only the organizer can change this event.");
    }
  }

  private async readEvents(start: Date, end: Date) {
    const calendars = await prisma.calendar.findMany({
      where: {
        connectionId: this.connection.connectionId,
        isEnabled: true,
        connection: {
          emailAccountId: this.connection.emailAccountId,
          isConnected: true,
        },
      },
      select: { calendarId: true, timezone: true },
    });
    if (!calendars.length) return [];

    const client = await createCalDavClient(this.connection);
    const events: ParsedCalDavEvent[] = [];
    for (const calendar of calendars) {
      const objects = await client.fetchCalendarObjects({
        calendar: { url: calendar.calendarId },
        timeRange: { start: start.toISOString(), end: end.toISOString() },
      });
      for (const object of objects) {
        events.push(
          ...parseCalDavEvents({
            object,
            email: this.connection.email,
            timezone: calendar.timezone ?? "UTC",
            start,
            end,
          }),
        );
      }
    }
    return events;
  }
}

export type ParsedCalDavEvent = { event: CalendarEvent; busy: boolean };

/**
 * Expands one calendar object into the events that overlap start..end.
 * Recurring series are expanded here, as not every server supports
 * expansion in calendar-query.
 */
export function parseCalDavEvents({
  object,
  email,
  timezone,
  start,
  end,
}: {
  object: Pick<DAVCalendarObject, "data" | "url">;
  email: string;
  timezone: string;
  start: Date;
  end: Date;
}): ParsedCalDavEvent[] {
  const calendar = parseCalendarObject(object);
  registerTimezones(calendar);

  const self = email.toLowerCase();
  const output: ParsedCalDavEvent[] = [];
  const components = calendar.getAllSubcomponents("vevent");

  for (const component of components) {
    const event = new ICAL.Event(component);
    if (isCancelled(component)) continue;
    // Exceptions are applied through the series they belong to.
    if (
      event.isRecurrenceException() &&
      components.some(
        (candidate) =>
          candidate.getFirstPropertyValue("uid") === event.uid &&
          candidate.hasProperty("rrule"),
      )
    ) {
      continue;
    }

    const add = (
      item: ICAL.Event,
      startTime: ICAL.Time,
      endTime: ICAL.Time,
      recurrence?: ICAL.Time,
    ) => {
      if (isCancelled(item.component)) return;
      const begin = toDate(startTime, timezone);
      const finish = toDate(endTime, timezone);
      if (begin >= end || finish <= start) return;

      const attendees = item.component
        .getAllProperties("attendee")
        .map((property) => {
          const attendeeEmail = emailValue(property.getFirstValue());
          return {
            email: attendeeEmail,
            name: property.getParameter("cn")?.toString(),
            declined:
              property.getParameter("partstat")?.toString().toUpperCase() ===
              "DECLINED",
            self: attendeeEmail === self,
          };
        })
        .filter((attendee) => attendee.email);
      const organizer = emailValue(
        item.component.getFirstPropertyValue("organizer"),
      );
      const description = String(
        item.component.getFirstPropertyValue("description") ?? "",
      );
      const location = String(
        item.component.getFirstPropertyValue("location") ?? "",
      );
      const userDeclined = attendees.some(
        (attendee) => attendee.self && attendee.declined,
      );

      output.push({
        event: {
          id: encodeEventId(object.url, item.component, recurrence),
          title: item.summary || "Untitled event",
          startTime: begin,
          endTime: finish,
          attendees,
          organizerEmail: organizer || undefined,
          isOrganizer: organizer === self,
          userDeclined,
          description: description || undefined,
          location: location || undefined,
          videoConferenceLink: findVideoConferenceLink(location, description),
        },
        busy:
          item.component.getFirstPropertyValue("transp") !== "TRANSPARENT" &&
          !userDeclined,
      });
    };

    if (!event.isRecurring()) {
      add(event, event.startDate, event.endDate);
      continue;
    }

    const iterator = event.iterator();
    let exhausted = false;
    for (let count = 0; count < MAX_OCCURRENCES; count++) {
      const next = iterator.next();
      if (!next || toDate(next, timezone) >= end) {
        exhausted = true;
        break;
      }
      const occurrence = event.getOccurrenceDetails(next);
      add(occurrence.item, occurrence.startDate, occurrence.endDate, next);
    }
    if (!exhausted) {
      throw new SafeError(
        "A recurring calendar event repeats more often than supported",
      );
    }
  }

  return output;
}

function parseCalendarObject(object: Pick<DAVCalendarObject, "data">) {
  if (typeof object.data !== "string" || object.data.length > MAX_OBJECT_SIZE)
    throw new SafeError("Invalid calendar event data");
  return new ICAL.Component(ICAL.parse(object.data));
}

// Times with a TZID resolve only against registered zones. Servers usually
// ship the VTIMEZONE in the same object.
function registerTimezones(calendar: ICAL.Component) {
  for (const zone of calendar.getAllSubcomponents("vtimezone")) {
    const tzid = zone.getFirstPropertyValue("tzid");
    if (typeof tzid === "string" && !ICAL.TimezoneService.has(tzid)) {
      ICAL.TimezoneService.register(new ICAL.Timezone(zone));
    }
  }
}

function toDate(time: ICAL.Time, fallbackTimezone: string) {
  const resolvedZone = time.zone?.tzid && time.zone.tzid !== "floating";
  if (!time.isDate && resolvedZone) return time.toJSDate();

  // All-day dates, floating times, and a TZID without a VTIMEZONE: read the
  // wall-clock time in the named zone when it is a real one, else the
  // calendar's zone.
  // ical.js keeps the unresolved TZID on the time, but does not type it.
  const tzid = (time as ICAL.Time & { timezone?: string }).timezone;
  const zone =
    !time.isDate && tzid && isValidTimezone(tzid) ? tzid : fallbackTimezone;
  return new Date(
    new TZDate(
      time.year,
      time.month - 1,
      time.day,
      time.isDate ? 0 : time.hour,
      time.isDate ? 0 : time.minute,
      time.isDate ? 0 : time.second,
      isValidTimezone(zone) ? zone : "UTC",
    ).getTime(),
  );
}

function isValidTimezone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function calendarTimezone(calendar: DAVCalendar) {
  if (!calendar.timezone) return null;
  try {
    const tzid = new ICAL.Component(ICAL.parse(calendar.timezone))
      .getFirstSubcomponent("vtimezone")
      ?.getFirstPropertyValue("tzid");
    return typeof tzid === "string" ? tzid : null;
  } catch {
    return null;
  }
}

function isCancelled(component: ICAL.Component) {
  return (
    String(component.getFirstPropertyValue("status") ?? "").toUpperCase() ===
    "CANCELLED"
  );
}

function encodeEventId(
  url: string,
  event: ICAL.Component,
  recurrence?: ICAL.Time,
) {
  const recurrenceId = event.getFirstPropertyValue("recurrence-id");
  return Buffer.from(
    JSON.stringify({
      url,
      uid: event.getFirstPropertyValue("uid"),
      recurrenceId:
        recurrence?.toString() ??
        (recurrenceId instanceof ICAL.Time ? recurrenceId.toString() : null),
    }),
  ).toString("base64url");
}

function emailValue(value: unknown) {
  return String(value ?? "")
    .replace(/^mailto:/i, "")
    .trim()
    .toLowerCase();
}

function sortAndLimit(events: CalendarEvent[], maxResults: number) {
  return events
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
    .slice(0, maxResults);
}

const eventIdSchema = z.object({
  url: z.string().url(),
  uid: z.string().min(1),
  recurrenceId: z.string().nullable(),
});

function decodeEventId(id: string) {
  try {
    return eventIdSchema.parse(
      JSON.parse(Buffer.from(id, "base64url").toString()),
    );
  } catch {
    throw new SafeError("Invalid calendar event id");
  }
}

function recurrenceIdOf(event: ICAL.Component) {
  const value = event.getFirstPropertyValue("recurrence-id");
  return value instanceof ICAL.Time ? value.toString() : null;
}

function findAttendee(event: ICAL.Component, email: string) {
  const wanted = email.toLowerCase();
  return event
    .getAllProperties("attendee")
    .find((property) => emailValue(property.getFirstValue()) === wanted);
}

/**
 * The event for a uid and recurrence. A single occurrence of a series has no
 * component of its own until it is changed, so it is split off the series as
 * a new exception.
 */
function findOrDetachOccurrence(
  calendar: ICAL.Component,
  uid: string,
  recurrenceId: string | null,
) {
  const events = calendar.getAllSubcomponents("vevent");
  const existing = events.find(
    (entry) =>
      entry.getFirstPropertyValue("uid") === uid &&
      recurrenceIdOf(entry) === recurrenceId,
  );
  if (existing || !recurrenceId) return existing;

  const master = events.find(
    (entry) =>
      entry.getFirstPropertyValue("uid") === uid &&
      !entry.hasProperty("recurrence-id"),
  );
  if (!master) return;

  const series = new ICAL.Event(master);
  const target = ICAL.Time.fromString(
    recurrenceId,
    master.getFirstProperty("dtstart") ?? undefined,
  );
  const iterator = series.iterator();
  for (let count = 0; count < MAX_OCCURRENCES; count++) {
    const occurrence = iterator.next();
    if (!occurrence || occurrence.compare(target) > 0) return;
    if (occurrence.toString() !== recurrenceId) continue;

    const details = series.getOccurrenceDetails(occurrence);
    const event = new ICAL.Component(
      JSON.parse(JSON.stringify(details.item.component.toJSON())),
    );
    for (const property of ["rrule", "rdate", "exdate", "exrule", "duration"]) {
      event.removeAllProperties(property);
    }
    event.updatePropertyWithValue("recurrence-id", occurrence);
    event.updatePropertyWithValue("dtstart", details.startDate);
    event.updatePropertyWithValue("dtend", details.endDate);
    calendar.addSubcomponent(event);
    return event;
  }
  return;
}

// Event ids carry the object URL, so an id must not point outside the
// calendar it is used with.
function isObjectInCalendar(calendarUrl: string, objectUrl: string) {
  try {
    const calendar = new URL(calendarUrl);
    const object = new URL(objectUrl, calendarUrl);
    return (
      object.origin === calendar.origin &&
      object.pathname.startsWith(withSlash(calendar.pathname))
    );
  } catch {
    return false;
  }
}

function withSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

function checkResponse(response: Response) {
  if (response.ok) return;
  throw new SafeError(
    response.status === 412
      ? "This event changed in another app. Reload it before editing."
      : `The calendar server refused the change (${response.status}).`,
  );
}

function bumpSequence(event: ICAL.Component) {
  event.updatePropertyWithValue(
    "sequence",
    Number(event.getFirstPropertyValue("sequence") ?? 0) + 1,
  );
  event.updatePropertyWithValue(
    "dtstamp",
    ICAL.Time.fromJSDate(new Date(), true),
  );
}

function hasWritePrivilege(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasWritePrivilege);
  return Object.entries(value).some(
    ([key, child]) =>
      ["all", "write", "writeContent", "write-content"].includes(key) ||
      hasWritePrivilege(child),
  );
}
