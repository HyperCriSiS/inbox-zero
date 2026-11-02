import type { ConnectionOptions } from "node:tls";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import {
  isBlockedIpAddress,
  isInternalHostname,
  normalizeHostname,
} from "@inboxzero/network/host-policy";
import { resolveHostAddresses } from "@inboxzero/network/pinned-dns";
import { env } from "@/env";
import type { Logger } from "@/utils/logger";

export type ImapSecurity = "tls" | "starttls" | "none";

export type ImapEndpoint = {
  host: string;
  port: number;
  security: ImapSecurity;
};

export type ImapConfig = {
  emailAccountId: string;
  imap: ImapEndpoint;
  password: string;
  smtp: ImapEndpoint;
  tlsPinnedCertPem?: string | null;
  username: string;
};

export class ImapConnectionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapConnectionPolicyError";
  }
}

const MAX_CONNECTIONS_PER_ACCOUNT = 3;
const CONNECTION_TIMEOUT_MS = 30_000;
const SOCKET_TIMEOUT_MS = 120_000;

/**
 * Resolves once and connects to that address, so a hostname cannot pass this
 * check and then rebind to an internal address.
 */
export async function resolveEndpointAddress(
  endpoint: ImapEndpoint,
  options: { allowPrivateHosts: boolean; allowPlaintext: boolean } = {
    allowPrivateHosts: env.IMAP_ALLOW_PRIVATE_HOSTS,
    allowPlaintext: env.IMAP_ALLOW_PLAINTEXT,
  },
): Promise<string> {
  if (endpoint.security === "none" && !options.allowPlaintext) {
    throw new ImapConnectionPolicyError(
      "Unencrypted connections are disabled on this server",
    );
  }

  const hostname = normalizeHostname(endpoint.host);
  if (!hostname) throw new ImapConnectionPolicyError("Invalid server name");

  const addresses = await resolveHostAddresses(hostname);
  if (options.allowPrivateHosts) return addresses[0].address;

  if (
    isInternalHostname(hostname) ||
    addresses.some(({ address }) => isBlockedIpAddress(address))
  ) {
    throw new ImapConnectionPolicyError(
      "Private and internal server addresses are not allowed",
    );
  }

  return addresses[0].address;
}

export function buildTlsOptions(
  servername: string,
  tlsPinnedCertPem: string | null | undefined,
): ConnectionOptions {
  if (!tlsPinnedCertPem) return { servername, rejectUnauthorized: true };

  // Node skips checkServerIdentity when chain validation fails, so a fingerprint
  // check there would never run for a self-signed certificate. The pinned
  // certificate is the only trust anchor instead, and it replaces the hostname
  // check because local bridges issue certificates without a matching name.
  return {
    servername,
    rejectUnauthorized: true,
    ca: tlsPinnedCertPem,
    checkServerIdentity: () => undefined,
  };
}

export function buildImapOptions(
  config: ImapConfig,
  address: string,
): ImapFlowOptions {
  const { host, port, security } = config.imap;

  return {
    host: address,
    port,
    servername: host,
    secure: security === "tls",
    doSTARTTLS: securityToStartTls(security),
    auth: { user: config.username, pass: config.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    tls: buildTlsOptions(host, config.tlsPinnedCertPem),
  };
}

export async function withImapClient<T>(
  config: ImapConfig,
  logger: Logger,
  run: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const release = await acquireConnectionSlot(config.emailAccountId);

  try {
    const address = await resolveEndpointAddress(config.imap);
    const client = new ImapFlow(buildImapOptions(config, address));
    // Without a listener a dropped socket is an uncaught 'error' event, which
    // takes down the whole process.
    client.on("error", (error) => {
      logger.warn("IMAP connection error", { error });
    });

    await client.connect();
    try {
      return await run(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  } finally {
    release();
  }
}

function securityToStartTls(security: ImapSecurity) {
  if (security === "starttls") return true;
  return security === "none" ? false : undefined;
}

// Mail servers cap connections per user and may ban on overflow. This is per
// process, which is enough while a single worker owns each account's sync lease.
const connectionQueues = new Map<
  string,
  { active: number; waiting: (() => void)[] }
>();

async function acquireConnectionSlot(emailAccountId: string) {
  const queue = connectionQueues.get(emailAccountId) ?? {
    active: 0,
    waiting: [],
  };
  connectionQueues.set(emailAccountId, queue);

  if (queue.active >= MAX_CONNECTIONS_PER_ACCOUNT) {
    await new Promise<void>((resolve) => queue.waiting.push(resolve));
  } else {
    queue.active += 1;
  }

  return () => {
    const next = queue.waiting.shift();
    if (next) {
      next();
      return;
    }
    queue.active -= 1;
    if (queue.active === 0) connectionQueues.delete(emailAccountId);
  };
}
