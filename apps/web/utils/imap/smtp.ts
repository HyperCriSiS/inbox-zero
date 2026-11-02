import nodemailer from "nodemailer";
import addressparser from "nodemailer/lib/addressparser";
import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";
import {
  buildTlsOptions,
  type ImapConfig,
  resolveEndpointAddress,
} from "@/utils/imap/connection";

const CONNECTION_TIMEOUT_MS = 30_000;

/** Encodes headers and body safely, so callers never assemble raw MIME. */
export async function composeMessage(
  options: Mail.Options,
): Promise<{ raw: Buffer; messageId: string }> {
  const message = new MailComposer(options).compile();
  // Drafts and the Sent copy need BCC. `sendRawMessage` strips it on the way out.
  message.keepBcc = true;
  const raw = await message.build();
  return { raw, messageId: message.messageId() };
}

export async function sendRawMessage(
  config: ImapConfig,
  envelope: { from: string; to: string[] },
  raw: Buffer,
) {
  const transport = await createTransport(config);
  try {
    await transport.sendMail({ envelope, raw: stripPrivateHeaders(raw) });
  } finally {
    transport.close();
  }
}

/**
 * Every recipient receives these exact bytes, so BCC must not be among them.
 * `X-Pm-*` is what Proton Mail Bridge adds to a draft read back from it, and a
 * draft sent with those accepted by Bridge never reached Sent.
 */
export function stripPrivateHeaders(raw: Buffer) {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1) return raw;

  const headers = raw.subarray(0, headerEnd).toString("latin1");
  const kept = headers.replace(
    /^(?:bcc|x-pm-[^:]*):.*(?:\r\n[ \t].*)*(?:\r\n|$)/gim,
    "",
  );
  return Buffer.concat([
    Buffer.from(kept.replace(/\r\n$/, ""), "latin1"),
    raw.subarray(headerEnd),
  ]);
}

export function parseRecipients(value: string | undefined) {
  if (!value) return [];
  return addressparser(value, { flatten: true }).map((item) => item.address);
}

export async function verifySmtp(config: ImapConfig) {
  const transport = await createTransport(config);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

async function createTransport(config: ImapConfig) {
  const { host, port, security } = config.smtp;
  const address = await resolveEndpointAddress(config.smtp);

  return nodemailer.createTransport({
    host: address,
    port,
    secure: security === "tls",
    requireTLS: security === "starttls",
    ignoreTLS: security === "none",
    auth: { user: config.username, pass: config.password },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    tls: buildTlsOptions(host, config.tlsPinnedCertPem),
  });
}
