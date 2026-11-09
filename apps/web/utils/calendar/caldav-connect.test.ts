import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { discoverCalDavCalendars } from "@/utils/calendar/providers/caldav";
import { connectCalDavCalendar } from "./caldav-connect";

vi.mock("@/utils/prisma");
vi.mock("@/utils/calendar/providers/caldav", () => ({
  discoverCalDavCalendars: vi.fn(),
  getCalDavUrlError: () => null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  prisma.emailAccount.findUniqueOrThrow.mockResolvedValue({
    email: "me@example.com",
  } as never);
  prisma.calendarConnection.upsert.mockResolvedValue({ id: "conn" } as never);
  prisma.$transaction.mockResolvedValue([]);
});

describe("connectCalDavCalendar", () => {
  it("refreshes write access when a calendar is linked again", async () => {
    vi.mocked(discoverCalDavCalendars).mockResolvedValue([
      {
        calendarId: "https://dav.example.com/cal/shared/",
        name: "Shared",
        description: null,
        timezone: null,
        primary: true,
        isReadOnly: true,
      },
    ]);

    await connectCalDavCalendar({
      emailAccountId: "account",
      serverUrl: "https://dav.example.com/",
      username: "me",
      password: "secret",
      email: "",
      logger: createTestLogger(),
    });

    expect(prisma.calendar.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ isReadOnly: true }),
      }),
    );
  });
});
