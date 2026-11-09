import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCalDavFetch } from "./caldav";

vi.mock("@/utils/prisma");
vi.mock("@/env", () => ({
  env: { IMAP_ALLOW_PRIVATE_HOSTS: true, IMAP_ALLOW_PLAINTEXT: true },
}));

type Seen = { method?: string; authorization?: string; body: string };

const servers: Server[] = [];

async function listen(
  handler: (url: string, seen: Seen) => { status: number; location?: string },
) {
  const requests: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const seen = {
        method: req.method,
        authorization: req.headers.authorization,
        body,
      };
      requests.push(seen);
      const { status, location } = handler(req.url ?? "/", seen);
      res.writeHead(status, location ? { location } : {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, requests };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

const init = {
  method: "PROPFIND",
  headers: { Authorization: "Basic c2VjcmV0", Depth: "0" },
  body: "<propfind/>",
};

describe("createCalDavFetch", () => {
  it("drops the login when a redirect leaves the server's site", async () => {
    const other = await listen(() => ({ status: 207 }));
    const origin = await listen(() => ({
      status: 307,
      // localhost is another site than 127.0.0.1.
      location: `http://localhost:${other.port}/dav/`,
    }));

    await createCalDavFetch(`http://127.0.0.1:${origin.port}/`)(
      `http://127.0.0.1:${origin.port}/.well-known/caldav`,
      init,
    );

    expect(origin.requests[0].authorization).toBe("Basic c2VjcmV0");
    expect(other.requests[0].authorization).toBeUndefined();
  });

  it("keeps the login for redirects on the same server", async () => {
    const server = await listen((url) =>
      url === "/start" ? { status: 301, location: "/dav/" } : { status: 207 },
    );

    await createCalDavFetch(`http://127.0.0.1:${server.port}/`)(
      `http://127.0.0.1:${server.port}/start`,
      init,
    );

    expect(server.requests.map((seen) => seen.authorization)).toEqual([
      "Basic c2VjcmV0",
      "Basic c2VjcmV0",
    ]);
    expect(server.requests[1].method).toBe("PROPFIND");
  });

  it("follows a 303 with a GET and no body", async () => {
    const server = await listen((url) =>
      url === "/start" ? { status: 303, location: "/next" } : { status: 200 },
    );

    await createCalDavFetch(`http://127.0.0.1:${server.port}/`)(
      `http://127.0.0.1:${server.port}/start`,
      init,
    );

    expect(server.requests[1]).toMatchObject({ method: "GET", body: "" });
  });
});
