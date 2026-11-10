import { describe, expect, it, vi } from "vitest";
import { getCalDavUrlError, parseCalDavEvents } from "./caldav";

vi.mock("@/utils/prisma");
vi.mock("@/env", () => ({
  env: { IMAP_ALLOW_PRIVATE_HOSTS: false, IMAP_ALLOW_PLAINTEXT: false },
}));

const BERLIN = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

function ics(...lines: string[]) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//EN",
    ...lines,
    "END:VCALENDAR",
  ].join("\r\n");
}

function parse(
  data: string,
  start = "2026-11-01T00:00:00Z",
  end = "2026-12-01T00:00:00Z",
) {
  return parseCalDavEvents({
    object: { url: "https://dav.example.com/cal/event.ics", data },
    email: "me@example.com",
    timezone: "Europe/Berlin",
    start: new Date(start),
    end: new Date(end),
  });
}

describe("parseCalDavEvents", () => {
  it("does not let one object's time zone definition leak into the next", () => {
    const event = [
      "BEGIN:VEVENT",
      "UID:leak",
      "DTSTAMP:20261101T000000Z",
      "DTSTART;TZID=Europe/Berlin:20261110T100000",
      "DTEND;TZID=Europe/Berlin:20261110T110000",
      "SUMMARY:Leak",
      "END:VEVENT",
    ];
    const wrongZone = [
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Berlin",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0900",
      "TZOFFSETTO:+0900",
      "END:STANDARD",
      "END:VTIMEZONE",
    ];

    parse(ics(...wrongZone, ...event));
    const [item] = parse(ics(...event));

    expect(item.event.startTime.toISOString()).toBe("2026-11-10T09:00:00.000Z");
  });

  it("keeps the other events when one series never ends", () => {
    const items = parse(
      ics(
        "BEGIN:VEVENT",
        "UID:runaway",
        "DTSTAMP:19700101T000000Z",
        "DTSTART:19700101T000000Z",
        "DTEND:19700101T000001Z",
        "RRULE:FREQ=SECONDLY",
        "SUMMARY:Runaway",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:normal",
        "DTSTAMP:20261101T000000Z",
        "DTSTART:20261105T100000Z",
        "DTEND:20261105T110000Z",
        "SUMMARY:Normal",
        "END:VEVENT",
      ),
    );

    expect(items.map((item) => item.event.title)).toEqual(["Normal"]);
  });

  it("reads a timed event in its own time zone", () => {
    const [item] = parse(
      ics(
        ...BERLIN,
        "BEGIN:VEVENT",
        "UID:one",
        "DTSTAMP:20261101T000000Z",
        "DTSTART;TZID=Europe/Berlin:20261105T100000",
        "DTEND;TZID=Europe/Berlin:20261105T110000",
        "SUMMARY:Planning",
        "ORGANIZER:mailto:boss@example.com",
        "ATTENDEE;CN=Me;PARTSTAT=ACCEPTED:mailto:Me@Example.com",
        "LOCATION:https://meet.example.com/abc",
        "END:VEVENT",
      ),
    );

    expect(item.event.title).toBe("Planning");
    expect(item.event.startTime.toISOString()).toBe("2026-11-05T09:00:00.000Z");
    expect(item.event.endTime.toISOString()).toBe("2026-11-05T10:00:00.000Z");
    expect(item.event.organizerEmail).toBe("boss@example.com");
    expect(item.event.isOrganizer).toBe(false);
    expect(item.event.attendees).toEqual([
      { email: "me@example.com", name: "Me", declined: false, self: true },
    ]);
    expect(item.busy).toBe(true);
  });

  it("reads a TZID that has no VTIMEZONE in the object", () => {
    const [item] = parse(
      ics(
        "BEGIN:VEVENT",
        "UID:two",
        "DTSTAMP:20261101T000000Z",
        "DTSTART;TZID=America/New_York:20261105T100000",
        "DTEND;TZID=America/New_York:20261105T103000",
        "SUMMARY:Call",
        "END:VEVENT",
      ),
    );

    expect(item.event.startTime.toISOString()).toBe("2026-11-05T15:00:00.000Z");
  });

  it("reads all-day events in the calendar's time zone", () => {
    const [item] = parse(
      ics(
        "BEGIN:VEVENT",
        "UID:three",
        "DTSTAMP:20261101T000000Z",
        "DTSTART;VALUE=DATE:20261110",
        "DTEND;VALUE=DATE:20261111",
        "SUMMARY:Holiday",
        "TRANSP:TRANSPARENT",
        "END:VEVENT",
      ),
    );

    expect(item.event.startTime.toISOString()).toBe("2026-11-09T23:00:00.000Z");
    expect(item.busy).toBe(false);
  });

  it("expands a series with an exception and an excluded date", () => {
    const items = parse(
      ics(
        ...BERLIN,
        "BEGIN:VEVENT",
        "UID:series",
        "DTSTAMP:20261101T000000Z",
        "DTSTART;TZID=Europe/Berlin:20261102T090000",
        "DTEND;TZID=Europe/Berlin:20261102T091500",
        "RRULE:FREQ=WEEKLY;COUNT=4",
        "EXDATE;TZID=Europe/Berlin:20261116T090000",
        "SUMMARY:Standup",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:series",
        "DTSTAMP:20261101T000000Z",
        "RECURRENCE-ID;TZID=Europe/Berlin:20261109T090000",
        "DTSTART;TZID=Europe/Berlin:20261109T140000",
        "DTEND;TZID=Europe/Berlin:20261109T141500",
        "SUMMARY:Standup moved",
        "END:VEVENT",
      ),
    );

    expect(
      items.map(({ event }) => [event.title, event.startTime.toISOString()]),
    ).toEqual([
      ["Standup", "2026-11-02T08:00:00.000Z"],
      ["Standup moved", "2026-11-09T13:00:00.000Z"],
      ["Standup", "2026-11-23T08:00:00.000Z"],
    ]);
    expect(new Set(items.map(({ event }) => event.id)).size).toBe(3);
  });

  it("skips cancelled events and frees declined ones", () => {
    const items = parse(
      ics(
        "BEGIN:VEVENT",
        "UID:cancelled",
        "DTSTAMP:20261101T000000Z",
        "DTSTART:20261105T100000Z",
        "DTEND:20261105T110000Z",
        "STATUS:CANCELLED",
        "SUMMARY:Gone",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:declined",
        "DTSTAMP:20261101T000000Z",
        "DTSTART:20261106T100000Z",
        "DTEND:20261106T110000Z",
        "SUMMARY:Not going",
        "ATTENDEE;PARTSTAT=DECLINED:mailto:me@example.com",
        "END:VEVENT",
      ),
    );

    expect(items).toHaveLength(1);
    expect(items[0].event.userDeclined).toBe(true);
    expect(items[0].busy).toBe(false);
  });

  it("drops events outside the window", () => {
    expect(
      parse(
        ics(
          "BEGIN:VEVENT",
          "UID:old",
          "DTSTAMP:20261101T000000Z",
          "DTSTART:20261005T100000Z",
          "DTEND:20261005T110000Z",
          "SUMMARY:Old",
          "END:VEVENT",
        ),
      ),
    ).toEqual([]);
  });
});

describe("getCalDavUrlError", () => {
  it("accepts a public https server", () => {
    expect(getCalDavUrlError("https://dav.example.com/")).toBeNull();
  });

  it("refuses plain http, embedded credentials and private hosts", () => {
    expect(getCalDavUrlError("http://dav.example.com/")).toMatch(/https/);
    expect(getCalDavUrlError("https://me:pw@dav.example.com/")).toMatch(
      /own fields/,
    );
    expect(getCalDavUrlError("https://127.0.0.1/")).toMatch(/Private/);
    expect(getCalDavUrlError("https://localhost:5232/")).toMatch(/Private/);
    expect(getCalDavUrlError("not a url")).toMatch(/full server URL/);
  });
});
