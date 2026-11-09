import ICAL from "ical.js";
import type { ImapFlow } from "imapflow";
import { createDAVClient } from "tsdav";
import { createCalDavFetch } from "@/utils/calendar/providers/caldav";
import type { EmailContact } from "@/utils/email/contact";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

const MAX_SENT_MATCHES = 50;
const MIN_QUERY_LENGTH = 2;
// The composer searches on every keystroke, and a CardDAV query cannot be
// relied on to filter, so each address book is read once per few minutes.
const ADDRESS_BOOK_CACHE_MS = 5 * 60_000;
const addressBookCache = new Map<
  string,
  { expiresAt: number; contacts: Promise<EmailContact[]> }
>();

/**
 * IMAP has no contacts. Suggestions come from the CardDAV address book of a
 * linked CalDAV calendar, which most servers serve with the same login, and
 * from the people the user has written to.
 */
export async function searchImapContacts({
  emailAccountId,
  query,
  withClient,
  sentPath,
  logger,
}: {
  emailAccountId: string;
  query: string;
  withClient: <T>(run: (client: ImapFlow) => Promise<T>) => Promise<T>;
  sentPath: string | null;
  logger: Logger;
}): Promise<EmailContact[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < MIN_QUERY_LENGTH) return [];

  const [cardDav, sent] = await Promise.all([
    searchCardDav(emailAccountId, needle).catch((error) => {
      logger.warn("CardDAV contact search failed", { error });
      return [];
    }),
    sentPath
      ? searchSentRecipients(withClient, sentPath, needle).catch((error) => {
          logger.warn("Sent folder contact search failed", { error });
          return [];
        })
      : [],
  ]);

  // Address book entries carry the names people chose, so they come first.
  return [...cardDav, ...sent];
}

async function searchCardDav(emailAccountId: string, needle: string) {
  const cached = addressBookCache.get(emailAccountId);
  if (cached && cached.expiresAt > Date.now()) {
    return (await cached.contacts).filter((contact) =>
      matchesQuery(contact, needle),
    );
  }
  const contacts = loadCardDavContacts(emailAccountId);
  addressBookCache.set(emailAccountId, {
    expiresAt: Date.now() + ADDRESS_BOOK_CACHE_MS,
    contacts,
  });
  contacts.catch(() => addressBookCache.delete(emailAccountId));
  return (await contacts).filter((contact) => matchesQuery(contact, needle));
}

async function loadCardDavContacts(emailAccountId: string) {
  const connections = await prisma.calendarConnection.findMany({
    where: { emailAccountId, provider: "caldav", isConnected: true },
    select: {
      email: true,
      caldavUrl: true,
      caldavUsername: true,
      caldavPassword: true,
    },
  });

  const contacts: EmailContact[] = [];
  for (const connection of connections) {
    if (!connection.caldavUrl || !connection.caldavPassword) continue;
    const client = await createDAVClient({
      serverUrl: connection.caldavUrl,
      credentials: {
        username: connection.caldavUsername ?? connection.email,
        password: connection.caldavPassword,
      },
      authMethod: "Basic",
      defaultAccountType: "carddav",
      fetch: createCalDavFetch(connection.caldavUrl),
    });

    for (const addressBook of await client.fetchAddressBooks()) {
      // Some servers, Stalwart among them, answer 404 for an empty book.
      const cards = await client
        .fetchVCards({ addressBook })
        .catch(() => [] as Awaited<ReturnType<typeof client.fetchVCards>>);
      for (const card of cards) {
        if (typeof card.data !== "string") continue;
        contacts.push(...parseVCardContacts(card.data));
      }
    }
  }
  return contacts;
}

export function parseVCardContacts(data: string): EmailContact[] {
  const parsed = ICAL.parse(data);
  const cards = (
    Array.isArray(parsed[0]) ? parsed : [parsed]
  ) as ConstructorParameters<typeof ICAL.Component>[0][];

  return cards.flatMap((jcal) => {
    const card = new ICAL.Component(jcal);
    const name = String(card.getFirstPropertyValue("fn") ?? "").trim();
    return card.getAllProperties("email").flatMap((property) => {
      const emailAddress = String(property.getFirstValue() ?? "")
        .replace(/^mailto:/i, "")
        .trim();
      return emailAddress ? [{ emailAddress, ...(name ? { name } : {}) }] : [];
    });
  });
}

// The server searches the To and Cc headers. The newest matches are read for
// their addresses, as one sent mail can name several people.
async function searchSentRecipients(
  withClient: <T>(run: (client: ImapFlow) => Promise<T>) => Promise<T>,
  sentPath: string,
  needle: string,
) {
  return withClient(async (client) => {
    const lock = await client.getMailboxLock(sentPath, { readOnly: true });
    try {
      const uids = await client.search(
        { or: [{ to: needle }, { cc: needle }] },
        { uid: true },
      );
      if (!uids || !uids.length) return [];

      const newest = uids.slice(-MAX_SENT_MATCHES);
      const contacts: EmailContact[] = [];
      for await (const message of client.fetch(
        newest,
        { envelope: true },
        { uid: true },
      )) {
        const envelope = message.envelope;
        for (const address of [
          ...(envelope?.to ?? []),
          ...(envelope?.cc ?? []),
        ]) {
          if (!address.address) continue;
          const contact = {
            emailAddress: address.address,
            ...(address.name ? { name: address.name } : {}),
          };
          if (matchesQuery(contact, needle)) contacts.push(contact);
        }
      }
      // fetch returns oldest first, and recent correspondents matter most.
      return contacts.reverse();
    } finally {
      lock.release();
    }
  });
}

function matchesQuery(contact: EmailContact, needle: string) {
  return (
    contact.emailAddress.toLowerCase().includes(needle) ||
    !!contact.name?.toLowerCase().includes(needle)
  );
}
