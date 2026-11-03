#!/usr/bin/env node
/**
 * Read-only IMAP probe. Reports how a mail server behaves without changing it,
 * so a real mailbox can be measured without linking it to the app.
 *
 * Folders open with EXAMINE and headers are read with BODY.PEEK, so no message,
 * flag or folder changes. The report holds counts and timings only: no subjects,
 * addresses or bodies, and custom folder names are replaced by numbers.
 *
 * Usage, from apps/web:
 *   node scripts/imap-readonly-probe.mjs --host 127.0.0.1 --port 1143 \
 *     --user you@proton.me --security starttls --ca bridge.crt
 *
 * The password is asked for in the terminal and is never stored. `--ca` trusts
 * only that certificate; leave it out for servers with a public certificate.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import { ImapFlow } from "imapflow";

const SYSTEM_FOLDERS = new Set([
  "INBOX",
  "Sent",
  "Drafts",
  "Archive",
  "Spam",
  "Trash",
  "All Mail",
  "Starred",
  "Labels",
  "Folders",
]);
const SAMPLE_PER_FOLDER = 500;
const INTERNAL_ID_DOMAIN = "@protonmail.internalid";

const { values: args } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "1143" },
    user: { type: "string" },
    security: { type: "string", default: "starttls" },
    ca: { type: "string" },
    out: { type: "string", default: "imap-probe-report.json" },
  },
});

if (!args.user) {
  console.error("Missing --user. See the top of this file for the usage.");
  process.exit(1);
}

const password = await readPassword("Password (input is hidden): ");
const client = new ImapFlow({
  host: args.host,
  port: Number(args.port),
  secure: args.security === "tls",
  doSTARTTLS: args.security === "starttls" ? true : undefined,
  tls: args.ca
    ? {
        ca: readFileSync(args.ca, "utf8"),
        checkServerIdentity: () => undefined,
      }
    : {},
  auth: { user: args.user, pass: password },
  logger: false,
  socketTimeout: 600_000,
});
client.on("error", (error) =>
  console.error("Connection error:", error.message),
);

await client.connect();

const report = {
  server: [...client.capabilities.keys()],
  note: "Counts and timings only. Custom folder names are replaced by numbers.",
  folders: [],
};
const copiesByMessageId = new Map();
let folderNumber = 0;

for (const folder of await client.list()) {
  const name = displayName(folder.path);
  const entry = { name, flags: [...folder.flags] };
  report.folders.push(entry);
  if (folder.flags.has("\\Noselect")) continue;

  console.log(`Reading ${name}...`);
  const [statusMs, status] = await timed(() =>
    client.status(folder.path, { messages: true, uidNext: true, unseen: true }),
  );
  Object.assign(entry, {
    messages: status.messages,
    unseen: status.unseen,
    statusMs,
  });

  const [selectMs, lock] = await timed(() =>
    client.getMailboxLock(folder.path, { readOnly: true }),
  );
  entry.selectMs = selectMs;
  try {
    const mailbox = client.mailbox;
    if (folder.path === "INBOX") {
      report.permanentFlagsReadOnly = [...(mailbox.permanentFlags ?? [])];
    }
    Object.assign(entry, await measureFolder(mailbox));
  } finally {
    lock.release();
  }
}

report.copies = summarizeCopies();
await client.logout();

writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nDone. Nothing was changed. Report: ${args.out}`);
process.exit(0);

async function measureFolder(mailbox) {
  if (!mailbox.exists) return {};

  const [searchAllMs, uids] = await timed(() =>
    client.search({ all: true }, { uid: true }),
  );
  const [flagsAllMs] = await timed(async () => {
    for await (const _ of client.fetch("1:*", { flags: true })) {
      // Only the time of the full read matters.
    }
  });

  const newest = uids.slice(-SAMPLE_PER_FOLDER);
  const sample = {
    size: newest.length,
    noMessageId: 0,
    internalMessageId: 0,
    duplicateMessageId: 0,
    noDate: 0,
    hasReferences: 0,
    extraHeaderNames: new Set(),
    flagNames: new Set(),
  };
  const seen = new Set();
  const [sampleMs] = await timed(async () => {
    for await (const message of client.fetch(
      newest.join(","),
      {
        flags: true,
        headers: ["message-id", "references", "date", "x-pm-internal-id"],
      },
      { uid: true },
    )) {
      inspectMessage(message, sample, seen);
    }
  });

  return {
    reportsModseq: mailbox.highestModseq !== undefined,
    searchAllMs,
    flagsAllMs,
    sampleMs,
    sample: {
      ...sample,
      extraHeaderNames: [...sample.extraHeaderNames],
      flagNames: [...sample.flagNames],
    },
  };
}

function inspectMessage(message, sample, seen) {
  const headers = message.headers?.toString("latin1") ?? "";
  const messageId = readHeader(headers, "message-id");
  const references = readHeader(headers, "references");

  if (!readHeader(headers, "date")) sample.noDate += 1;
  if (references) sample.hasReferences += 1;
  for (const flag of message.flags ?? []) {
    if (!flag.startsWith("\\") && !flag.startsWith("$")) continue;
    sample.flagNames.add(flag);
  }
  if (readHeader(headers, "x-pm-internal-id")) {
    sample.extraHeaderNames.add("X-Pm-Internal-Id");
  }

  if (!messageId) {
    sample.noMessageId += 1;
    return;
  }
  if (messageId.includes(INTERNAL_ID_DOMAIN)) sample.internalMessageId += 1;
  if (seen.has(messageId)) sample.duplicateMessageId += 1;
  seen.add(messageId);

  const key = createHash("sha256").update(messageId).digest("hex");
  const copies = copiesByMessageId.get(key) ?? [];
  copies.push(createHash("sha256").update(references).digest("hex"));
  copiesByMessageId.set(key, copies);
}

function summarizeCopies() {
  const groups = [...copiesByMessageId.values()].filter(
    (copies) => copies.length > 1,
  );
  return {
    messagesInSeveralFolders: groups.length,
    copiesWithDifferentReferences: groups.filter(
      (copies) => new Set(copies).size > 1,
    ).length,
  };
}

function readHeader(headers, name) {
  const match = headers.match(
    new RegExp(`^${name}:[ \\t]*((?:.*)(?:\\r\\n[ \\t].*)*)`, "im"),
  );
  return match ? match[1].trim() : "";
}

function displayName(path) {
  if (SYSTEM_FOLDERS.has(path)) return path;
  folderNumber += 1;
  const root = path.split("/")[0];
  return SYSTEM_FOLDERS.has(root)
    ? `${root}/#${folderNumber}`
    : `#${folderNumber}`;
}

async function timed(run) {
  const start = performance.now();
  const result = await run();
  return [Math.round(performance.now() - start), result];
}

function readPassword(prompt) {
  return new Promise((resolve) => {
    stdout.write(prompt);
    let value = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", function onData(chunk) {
      for (const char of chunk) {
        if (char === "\u0003") process.exit(130);
        if (char === "\r" || char === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0008" || char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    });
  });
}
