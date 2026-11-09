# Generic IMAP/SMTP provider: design

Fork-only feature. The goal is full feature parity where IMAP allows it, across
servers with very different capabilities (Dovecot, Proton Mail Bridge, web.de,
GMX), while staying easy to merge with upstream.

## Merge rules

- New code lives in `utils/imap/`, `utils/email/imap.ts` and `app/api/imap/`.
- Upstream files get the smallest possible hook, preferably one line.
- All IMAP state hangs off `ImapConnection`, so `EmailAccount` gains one relation.
- The password is encrypted by one line in `utils/prisma-extensions.ts`.

## Identity

IMAP has no stable message ID: a UID is only valid within one mailbox and one
UIDVALIDITY, and a move changes it. The app stores message IDs in its own tables,
so `ImapMessage.id` is the ID the app sees. A row maps it to the current location.

- Lookup after a move: `OBJECTID` when offered, otherwise the RFC 5322 Message-ID.
- A UIDVALIDITY change invalidates the mailbox's rows and triggers a rescan.
- UIDVALIDITY, UID and MODSEQ are unsigned, so they are stored as `BigInt`.

## Threading

`utils/imap/thread.ts` is pure and works on normalized Message-IDs.

1. Adopt the thread of any message referenced by, or referencing, this message.
2. Otherwise derive the thread ID from the oldest referenced ID.
3. A message that joins several threads reports them for merging.
4. A message without Message-ID gets a thread of its own, never a shared one.

Sent and Drafts are indexed too, otherwise replies never join their thread.

## Capabilities

Detected on connect and stored on `ImapConnection`, never assumed per vendor.

| Feature | Preferred | Fallback |
| --- | --- | --- |
| Labels | Keywords (`PERMANENTFLAGS` has `\*`) | `Labels/` folders, then database only |
| Sync | CONDSTORE / QRESYNC | UID diff |
| New mail | IDLE | Polling |
| Sent copy | Server stores it | APPEND to Sent |

## Sync

One queue job per account under a database lease. Intake writes `ImapSyncItem`
rows and advances the mailbox cursor in one transaction, so a crash leaves work
pending instead of losing it. Rules run through `processHistoryItem`. The first
sync sets a baseline and never processes old mail.

## Security

- Passwords use the existing encryption and never reach logs or responses.
- `tls` and `starttls` both require encryption (`doSTARTTLS`, `requireTLS`).
- `none` needs an explicit server-side opt-in.
- A self-signed certificate is pinned as the only trusted CA, as Proton Mail Bridge
  needs. A fingerprint check would not run: Node skips `checkServerIdentity` when
  chain validation fails.
- Private hosts are rejected unless allowed by the operator, to prevent SSRF.
- Linking verifies the credentials on the server before storing them.
- Polling requires `hasCronSecret`.
- Password sign-in stays off unless enabled by env.
- Raw messages are built by Nodemailer's composer, never by string concatenation.
- At most three connections per account, with backoff, and `disconnectedAt` is
  set on authentication failure.
