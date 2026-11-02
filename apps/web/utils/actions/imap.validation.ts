import { z } from "zod";

const imapSecuritySchema = z.enum(["tls", "starttls", "none"]);
const hostSchema = z.string().trim().min(1).max(253);
const portSchema = z.number().int().min(1).max(65_535);

export const linkImapAccountBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().max(200).optional(),
  imapHost: hostSchema,
  imapPort: portSchema,
  imapSecurity: imapSecuritySchema,
  smtpHost: hostSchema,
  smtpPort: portSchema,
  smtpSecurity: imapSecuritySchema,
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1024),
  tlsPinnedCertPem: z.string().trim().max(16_000).optional(),
});
export type LinkImapAccountBody = z.infer<typeof linkImapAccountBody>;
