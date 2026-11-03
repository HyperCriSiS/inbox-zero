# IMAP/SMTP mailboxes

This fork connects any IMAP/SMTP mailbox next to Gmail and Outlook. Rules, the
assistant, drafts, labels and the mail client work on these accounts. The design
is in [IMAP_PROVIDER_DESIGN.md](./IMAP_PROVIDER_DESIGN.md).

## Setup

The published `ghcr.io/elie222/inbox-zero` image has no IMAP support, so build the
image from this fork and point `docker-compose.yml` at it:

```bash
docker build -f docker/Dockerfile.prod -t inbox-zero-imap .
```

```bash
INBOX_ZERO_IMAGE=inbox-zero-imap INBOX_ZERO_PULL_POLICY=never docker compose up -d
```

1. Apply the database migrations.
2. Make sure polling runs. `docker-compose.yml` calls `/api/imap/poll` every
   minute with `CRON_SECRET`. On another setup, schedule the same `GET` request:

   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://your-host/api/imap/poll
   ```

3. Open **Accounts**, choose **Add other mail account (IMAP)** and pick a preset
   or enter the server settings. The password is checked before it is stored.

## Settings

| Variable | Purpose |
| --- | --- |
| `IMAP_ALLOW_PRIVATE_HOSTS` | Allows IMAP, SMTP and CalDAV servers on private addresses, such as Proton Mail Bridge or a Nextcloud on the same network. Disables SSRF protection, so use it on trusted single-tenant installs only. |
| `IMAP_ALLOW_PLAINTEXT` | Allows the security option `None`, and `http://` CalDAV URLs, which send the password unencrypted. |
| `IMAP_IDLE_ENABLED` | Keeps one IMAP IDLE connection per account open on the inbox, so new mail is processed within seconds instead of on the next poll. Needs a long-running server, such as the Docker image; on serverless hosts leave it off. |
| `REVIEW_BEFORE_DELETE_LABEL` | Nothing goes to Trash or Spam. Rules, the chat, bulk actions and the mail view move that mail to this folder (a label on Gmail) instead, for you to check and empty. Undo brings it back to the inbox. Works for every provider. |
| `NEXT_PUBLIC_AUTH_PASSWORD_ENABLED` | Enables password sign-in without Google or Microsoft. Needs an allowlist below, otherwise it stays off. |
| `AUTH_ALLOWED_EMAILS`, `AUTH_ALLOWED_EMAIL_DOMAINS` | Limit who can sign up. Set these on any install reachable by others, because a linked address is not verified as belonging to the user. |

Without Google, set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
`GOOGLE_PUBSUB_TOPIC_NAME` to `skipped`, which also hides the Google sign-in. Set
`NEXT_PUBLIC_IMAP_ONLY=true` to hide the Google and Microsoft account buttons too.

## Providers

The app asks the server what it supports, so no provider is special-cased.

- **web.de and GMX:** enable IMAP in the mailbox settings first.
- **Proton Mail:** IMAP needs Proton Mail Bridge running where the app can reach
  it, and Bridge needs a paid Proton plan. Set `IMAP_ALLOW_PRIVATE_HOSTS`, use the
  Bridge password, and paste the certificate exported from Bridge into the pinned
  certificate field. From Docker the host is `host.docker.internal`, not `127.0.0.1`.
- **Gmail and Outlook:** use the native connection, which supports push and filters.

## Calendar

IMAP has no calendar, so add one under **Calendars** with **Add CalDAV Calendar**:
the server URL, user name and password, ideally an app password. It speaks plain
CalDAV, so Nextcloud, iCloud, Fastmail, mailbox.org and Radicale should work; the
tests run against Stalwart. Discovery starts from the URL, so the server root is
usually enough, for example `https://cloud.example.com/remote.php/dav` for Nextcloud or
`https://caldav.icloud.com` for iCloud.

CalDAV calendars give meeting context to drafts and the assistant, and their busy
times count for availability. Recurring events are expanded in the app. Events
cannot be created in a CalDAV calendar yet, so booking links need a Google or
Microsoft calendar, and invitations are not answered from the app.

## Behavior

- New mail is found by polling, so it can take up to a minute to appear. With
  `IMAP_IDLE_ENABLED=true` the server reports new mail in the inbox at once and a sync
  starts within seconds; polling keeps running for the other folders and for servers
  without IDLE. Each account then holds one extra connection, and several app
  instances each open their own. Polling queues one job per account on the
  `imap-sync` queue, and rules run for at most 100 messages per job, so a large
  burst drains over several runs.
- Linking indexes the newest 1,000 messages per folder. Older mail stays reachable
  through search.
- Labels become IMAP keywords where the server allows them, which appear as tags in
  Thunderbird when defined there. Proton uses its `Labels` folders, which cannot
  nest, so `Inbox Zero/Processed` becomes `Inbox Zero - Processed`. A label set on
  Proton shows after the next sync. Other servers keep labels in the app only, so
  other clients do not see them.
- Proton files sent mail itself, which took up to 40 seconds in tests, so it can
  need a further poll to appear in Sent. New custom folders go under its `Folders`
  root.
- Rules and sender filters, such as auto-archive, run in the app when new mail is
  synced. Contact search, signatures and contact photos are not available.
- Moving mail into a rule's folder in another client, or from it back to the inbox,
  is saved as feedback for that rule, as adding or removing a label is on Gmail.
  The assistant uses it when it picks rules for that sender. At most 50 moves are
  read per poll.
- Rules for a message are tried on five polls, then it is skipped so one broken
  message cannot block the queue. An outage of the AI provider, such as rate limits,
  overload or a dropped connection, does not count as a try: the poll stops and the
  message is tried again on the next one, for up to three days.
- Without CONDSTORE, as on Proton Mail Bridge, every poll compares the indexed range
  of every folder. A test mailbox with 60,000 messages in 9 folders took under 2
  seconds per poll, and about 6 seconds with 72 folders.
- Links in summary emails and notifications open the app's mail view, because IMAP
  has no web client to link to.
- After a rejected password the account stops connecting, to avoid a lockout. Add
  the account again under **Accounts** with the new password. Its data is kept.

## Tests

Unit tests run with the normal suite. The live test needs Postgres, Dovecot and an
SMTP sink; the commands are at the top of
`apps/web/__tests__/integration/imap-provider.test.ts`.
Set `IMAP_TEST_PLAIN=1` and `IMAP_TEST_PORT` to run it against GreenMail, a server
without CONDSTORE or SPECIAL-USE, and `IMAP_TEST_LARGE=1` to add the large mailbox case.
For a server that needs a prepared account, such as Stalwart with its OBJECTID and
QRESYNC support, set `IMAP_TEST_USER` and `IMAP_TEST_PASSWORD`. Each such run needs a
fresh mailbox. `docker/proton-bridge-test` runs the real Proton Mail Bridge without a
Proton account.

`apps/web/__tests__/integration/caldav.test.ts` reads a real CalDAV server, such as
Stalwart on its HTTP port, with `CALDAV_TEST_URL`, `CALDAV_TEST_USER` and
`CALDAV_TEST_PASSWORD`. It writes three events and removes them again.

To measure a real mailbox without linking it, run the read-only probe from `apps/web`.
It changes nothing and reports only counts and timings, no subjects or addresses:

```bash
node scripts/imap-readonly-probe.mjs --host 127.0.0.1 --port 1143 --user you@proton.me --ca bridge.crt
```

## Merging upstream

```bash
git fetch upstream
```

```bash
git merge upstream/main
```

Most code lives in `utils/imap/`, `utils/email/imap.ts` and `app/api/imap/`. A new
method on `EmailProvider` shows up as a compile error in `utils/email/imap.ts`. New
SQLite migrations upstream do not conflict, because the IMAP one uses ID 9001.
