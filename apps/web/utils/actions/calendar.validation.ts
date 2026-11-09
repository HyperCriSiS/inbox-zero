import { z } from "zod";
import { isValidTimeZone } from "@inboxzero/scheduling";

export const disconnectCalendarBody = z.object({
  connectionId: z.string(),
});
export type DisconnectCalendarBody = z.infer<typeof disconnectCalendarBody>;

export const toggleCalendarBody = z.object({
  calendarId: z.string(),
  isEnabled: z.boolean(),
});
export type ToggleCalendarBody = z.infer<typeof toggleCalendarBody>;

export const updateTimezoneBody = z.object({
  timezone: z.string().refine(isValidTimeZone, {
    message: "Use a valid IANA timezone",
  }),
});
export type UpdateTimezoneBody = z.infer<typeof updateTimezoneBody>;

export const updateBookingLinkBody = z.object({
  bookingLink: z
    .string()
    .url("Must be a valid URL")
    .optional()
    .or(z.literal("")),
});
export type UpdateBookingLinkBody = z.infer<typeof updateBookingLinkBody>;

export const connectCalDavCalendarBody = z.object({
  serverUrl: z.string().trim().min(1, "Enter the server URL").max(2048),
  username: z.string().trim().min(1, "Enter the user name").max(320),
  password: z.string().min(1, "Enter the password").max(1024),
  email: z
    .string()
    .trim()
    .email("Enter a valid email address")
    .max(320)
    .optional()
    .or(z.literal("")),
});
export type ConnectCalDavCalendarBody = z.infer<
  typeof connectCalDavCalendarBody
>;
