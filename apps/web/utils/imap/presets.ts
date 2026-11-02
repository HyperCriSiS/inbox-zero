import type { LinkImapAccountBody } from "@/utils/actions/imap.validation";

type ImapPreset = { name: string } & Pick<
  LinkImapAccountBody,
  | "imapHost"
  | "imapPort"
  | "imapSecurity"
  | "smtpHost"
  | "smtpPort"
  | "smtpSecurity"
>;

function tlsPreset(
  name: string,
  imapHost: string,
  smtpHost: string,
  smtp: { port: number; security: "tls" | "starttls" },
): ImapPreset {
  return {
    name,
    imapHost,
    imapPort: 993,
    imapSecurity: "tls",
    smtpHost,
    smtpPort: smtp.port,
    smtpSecurity: smtp.security,
  };
}

const SMTPS = { port: 465, security: "tls" } as const;
const SUBMISSION = { port: 587, security: "starttls" } as const;

export const IMAP_PRESETS: ImapPreset[] = [
  tlsPreset("web.de", "imap.web.de", "smtp.web.de", SUBMISSION),
  tlsPreset("GMX", "imap.gmx.net", "mail.gmx.net", SUBMISSION),
  tlsPreset("mailbox.org", "imap.mailbox.org", "smtp.mailbox.org", SMTPS),
  tlsPreset("Posteo", "posteo.de", "posteo.de", SUBMISSION),
  tlsPreset("Fastmail", "imap.fastmail.com", "smtp.fastmail.com", SMTPS),
  tlsPreset("Yahoo", "imap.mail.yahoo.com", "smtp.mail.yahoo.com", SMTPS),
  tlsPreset("iCloud", "imap.mail.me.com", "smtp.mail.me.com", SUBMISSION),
  {
    // Needs IMAP_ALLOW_PRIVATE_HOSTS and the Bridge certificate. In Docker the
    // host is reachable as host.docker.internal, not 127.0.0.1.
    name: "Proton Mail Bridge",
    imapHost: "127.0.0.1",
    imapPort: 1143,
    imapSecurity: "starttls",
    smtpHost: "127.0.0.1",
    smtpPort: 1025,
    smtpSecurity: "starttls",
  },
];
