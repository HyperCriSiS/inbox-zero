/**
 * Integration test: CalDAV calendars against a real server.
 *
 * Stalwart serves CalDAV next to IMAP:
 *   docker run -d -p 38081:8080 stalwartlabs/stalwart:v0.13
 *
 * Usage:
 *   CALDAV_TEST_URL=http://127.0.0.1:38081 CALDAV_TEST_USER=tester \
 *     CALDAV_TEST_PASSWORD=... IMAP_ALLOW_PRIVATE_HOSTS=true \
 *     IMAP_ALLOW_PLAINTEXT=true pnpm test-integration caldav
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { connectCalDavCalendar } from "@/utils/calendar/caldav-connect";
import { createCalendarEventProviders } from "@/utils/calendar/event-provider";
import {
  type CalDavCalendarProvider,
  createCalDavClient,
} from "@/utils/calendar/providers/caldav";
import {
  cancelCalendarEvent,
  createCalendarEvent,
  updateCalendarEvent,
} from "@/utils/calendar/event-writer";
import { getUnifiedCalendarAvailability } from "@/utils/calendar/unified-availability";
import { searchImapContacts } from "@/utils/imap/contacts";
import prisma from "@/utils/prisma";

const SERVER_URL = process.env.CALDAV_TEST_URL;
const USERNAME = process.env.CALDAV_TEST_USER ?? "tester";
const PASSWORD = process.env.CALDAV_TEST_PASSWORD ?? "";

describe.skipIf(!SERVER_URL || !process.env.RUN_INTEGRATION_TESTS)(
  "CalDAV calendar",
  () => {
    const run = randomUUID().slice(0, 8);
    const email = `caldav-${run}@example.com`;
    const logger = createTestLogger();
    const credentials = {
      serverUrl: SERVER_URL as string,
      username: USERNAME,
      password: PASSWORD,
    };
    let userId: string;
    let emailAccountId: string;
    const createdUrls: string[] = [];

    // Next Monday 09:00 UTC, so the events are in the future on any run day.
    const monday = new Date();
    monday.setUTCDate(
      monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7 || 7),
    );
    monday.setUTCHours(9, 0, 0, 0);
    const at = (days: number, hours = 0) =>
      new Date(monday.getTime() + days * 86_400_000 + hours * 3_600_000);
    const stamp = (date: Date) =>
      `${date.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;

    async function putEvent(uid: string, lines: string[]) {
      const client = await createCalDavClient(credentials);
      const [calendar] = await client.fetchCalendars();
      const response = await client.createCalendarObject({
        calendar,
        filename: `${uid}.ics`,
        iCalString: [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//Inbox Zero//Test//EN",
          "BEGIN:VEVENT",
          `UID:${uid}`,
          `DTSTAMP:${stamp(new Date())}`,
          ...lines,
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
      });
      expect(response.ok).toBe(true);
      createdUrls.push(
        new URL(`${uid}.ics`, `${calendar.url}/`.replace(/\/+$/, "/")).href,
      );
    }

    beforeAll(async () => {
      const client = await createCalDavClient(credentials);
      if (!(await client.fetchCalendars()).length) {
        const account = await client.createAccount({
          account: { serverUrl: credentials.serverUrl, accountType: "caldav" },
        });
        await client.makeCalendar({
          url: `${account.homeUrl}inbox-zero-test/`,
          props: { displayname: "Inbox Zero test" },
        });
      }

      await putEvent(`planning-${run}`, [
        `DTSTART:${stamp(at(0))}`,
        `DTEND:${stamp(at(0, 1))}`,
        `SUMMARY:Planning ${run}`,
        "ORGANIZER:mailto:boss@example.com",
        `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${email}`,
        "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest@example.org",
      ]);
      await putEvent(`standup-${run}`, [
        `DTSTART:${stamp(at(1))}`,
        `DTEND:${stamp(new Date(at(1).getTime() + 15 * 60_000))}`,
        "RRULE:FREQ=DAILY;COUNT=3",
        `SUMMARY:Standup ${run}`,
      ]);
      await putEvent(`free-${run}`, [
        `DTSTART:${stamp(at(2, 3))}`,
        `DTEND:${stamp(at(2, 4))}`,
        "TRANSP:TRANSPARENT",
        `SUMMARY:Focus ${run}`,
      ]);

      const user = await prisma.user.create({ data: { email } });
      userId = user.id;
      const account = await prisma.account.create({
        data: {
          userId,
          provider: "imap",
          providerAccountId: email,
          type: "credential",
        },
      });
      const emailAccount = await prisma.emailAccount.create({
        data: { email, userId, accountId: account.id },
      });
      emailAccountId = emailAccount.id;
    });

    afterAll(async () => {
      if (userId) await prisma.user.deleteMany({ where: { id: userId } });
      const client = await createCalDavClient(credentials);
      for (const url of createdUrls) {
        await client.deleteCalendarObject({
          calendarObject: { url, etag: "" },
        });
      }
    });

    test("connecting stores the calendars and an encrypted password", async () => {
      const result = await connectCalDavCalendar({
        emailAccountId,
        ...credentials,
        email,
        logger,
      });
      expect(result.calendarCount).toBeGreaterThan(0);

      const [stored] = await prisma.$queryRaw<
        { caldavPassword: string }[]
      >`SELECT "caldavPassword" FROM "CalendarConnection" WHERE id = ${result.connectionId}`;
      expect(stored.caldavPassword).not.toBe(PASSWORD);
      await expect(
        prisma.calendar.count({ where: { connectionId: result.connectionId } }),
      ).resolves.toBe(result.calendarCount);
    });

    test("a wrong password is refused without storing anything", async () => {
      await expect(
        connectCalDavCalendar({
          emailAccountId,
          ...credentials,
          password: "wrong-password",
          email: `other-${run}@example.com`,
          logger,
        }),
      ).rejects.toThrow(/Could not reach the calendar/);
      await expect(
        prisma.calendarConnection.count({
          where: { emailAccountId, email: `other-${run}@example.com` },
        }),
      ).resolves.toBe(0);
    });

    test("events are read with attendees and expanded series", async () => {
      const providers = await createCalendarEventProviders(
        emailAccountId,
        logger,
      );
      expect(providers).toHaveLength(1);

      const events = (
        await providers[0].fetchEvents({ timeMin: at(-1), timeMax: at(7) })
      ).filter((event) => event.title.endsWith(run));

      expect(events.map((event) => event.title)).toEqual([
        `Planning ${run}`,
        `Standup ${run}`,
        `Standup ${run}`,
        `Focus ${run}`,
        `Standup ${run}`,
      ]);
      expect(events[0].startTime.toISOString()).toBe(at(0).toISOString());
      expect(events[0].organizerEmail).toBe("boss@example.com");
      expect(events[0].attendees).toContainEqual(
        expect.objectContaining({ email, self: true }),
      );

      const withGuest = await providers[0].fetchEventsWithAttendee({
        attendeeEmail: "Guest@example.org",
        timeMin: at(-1),
        timeMax: at(7),
        maxResults: 10,
      });
      expect(withGuest.map((event) => event.title)).toEqual([
        `Planning ${run}`,
      ]);
    });

    test("availability counts busy events and skips free ones", async () => {
      const busy = await getUnifiedCalendarAvailability({
        emailAccountId,
        startDate: at(-1),
        endDate: at(7),
        exactRange: true,
        logger,
      });
      const starts = busy.map((period) => new Date(period.start).getTime());

      expect(starts).toContain(at(0).getTime());
      expect(starts).toContain(at(3).getTime());
      expect(starts).not.toContain(at(2, 3).getTime());
    });

    test("a booking is created, moved and cancelled in the calendar", async () => {
      const created = await createCalendarEvent({
        emailAccountId,
        title: `Booked ${run}`,
        startTime: at(4, 2),
        endTime: at(4, 3),
        timezone: "UTC",
        attendees: [{ email: "client@example.org", name: "Client" }],
        locationType: "CUSTOM",
        locationValue: "https://meet.example.org/room",
        logger,
      });
      expect(created.provider).toBe("caldav");
      const ref = {
        providerConnectionId: created.providerConnectionId,
        providerCalendarId: created.providerCalendarId,
        providerEventId: created.id,
        emailAccountId,
        logger,
      };
      const [provider] = await createCalendarEventProviders(
        emailAccountId,
        logger,
      );
      const booked = () =>
        provider
          .fetchEvents({ timeMin: at(3), timeMax: at(6) })
          .then((events) =>
            events.filter((event) => event.title === `Booked ${run}`),
          );

      const [event] = await booked();
      expect(event.startTime.toISOString()).toBe(at(4, 2).toISOString());
      expect(event.isOrganizer).toBe(true);
      expect(event.attendees).toContainEqual(
        expect.objectContaining({ email: "client@example.org" }),
      );

      await updateCalendarEvent({
        ...ref,
        startTime: at(5, 1),
        endTime: at(5, 2),
        timezone: "UTC",
      });
      expect((await booked())[0].startTime.toISOString()).toBe(
        at(5, 1).toISOString(),
      );

      await cancelCalendarEvent(ref);
      expect(await booked()).toEqual([]);
    });

    test("answering an invitation updates the attendee in the calendar", async () => {
      const uid = `invite-${run}`;
      await putEvent(uid, [
        `DTSTART:${stamp(at(6))}`,
        `DTEND:${stamp(at(6, 1))}`,
        `SUMMARY:Invite ${run}`,
        "SEQUENCE:0",
        "ORGANIZER:mailto:boss@example.com",
        `ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${email}`,
      ]);
      const invitation = {
        uid,
        recurrenceId: null,
        organizer: "boss@example.com",
        attendee: email,
        sequence: 0,
      } as Parameters<CalDavCalendarProvider["findInvitationEvent"]>[0];
      const [provider] = (await createCalendarEventProviders(
        emailAccountId,
        logger,
      )) as CalDavCalendarProvider[];

      const found = await provider.findInvitationEvent(invitation);
      expect(found?.response).toBe("needs-action");

      const result = await provider.respondToInvitation(
        found?.id ?? "",
        invitation,
        "accepted",
      );
      expect(result.organizerNotified).toBe(false);
      expect((await provider.findInvitationEvent(invitation))?.response).toBe(
        "accepted",
      );
    });

    test("contacts come from the CardDAV address book on the same login", async () => {
      const auth = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;
      const book = new URL(`/dav/card/${USERNAME}/inbox-zero-test/`, SERVER_URL)
        .href;
      // Extended MKCOL creates the address book if this server has none yet.
      await fetch(book, {
        method: "MKCOL",
        headers: { Authorization: auth, "Content-Type": "application/xml" },
        body: `<?xml version="1.0"?><d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:set><d:prop><d:resourcetype><d:collection/><c:addressbook/></d:resourcetype><d:displayname>Inbox Zero test</d:displayname></d:prop></d:set></d:mkcol>`,
      });
      const card = new URL(`zora-${run}.vcf`, book).href;
      const put = await fetch(card, {
        method: "PUT",
        headers: { Authorization: auth, "Content-Type": "text/vcard" },
        body: [
          "BEGIN:VCARD",
          "VERSION:3.0",
          `UID:zora-${run}`,
          `FN:Zora ${run}`,
          `EMAIL:zora-${run}@example.org`,
          "END:VCARD",
        ].join("\r\n"),
      });
      expect(put.ok).toBe(true);

      try {
        const contacts = await searchImapContacts({
          emailAccountId,
          query: `zora ${run}`,
          withClient: () => {
            throw new Error("no IMAP in this test");
          },
          sentPath: null,
          logger,
        });
        expect(contacts).toEqual([
          { emailAddress: `zora-${run}@example.org`, name: `Zora ${run}` },
        ]);
      } finally {
        await fetch(card, {
          method: "DELETE",
          headers: { Authorization: auth },
        });
      }
    });
  },
);
