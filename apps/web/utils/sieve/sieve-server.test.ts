import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import {
  callSieveTool,
  headerBlock,
  parseSieveSuggestions,
  toMessages,
} from "./sieve-server";

vi.mock("@/utils/prisma");

const { callTool } = vi.hoisted(() => ({ callTool: vi.fn() }));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = vi.fn();
    close = vi.fn(async () => undefined);
    callTool = callTool;
  },
}));
vi.mock("@/utils/mcp/resolve-integration", () => ({
  resolveMcpIntegration: vi.fn(async () => ({ name: "custom_sieve" })),
}));
vi.mock("@/utils/mcp/server-connection", () => ({
  getMcpServerConnection: vi.fn(async () => ({ url: "http://x", headers: {} })),
}));
vi.mock("@/utils/mcp/transport", () => ({ createMcpTransport: vi.fn() }));

const logger = createTestLogger();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("headerBlock", () => {
  it("returns the headers and never the body", () => {
    const source = Buffer.from(
      "From: a@example.com\r\nSubject: Hi\r\n\r\nSecret body\r\n",
    );

    expect(headerBlock(source)).toBe("From: a@example.com\r\nSubject: Hi");
  });

  it.each([
    [
      "a blank line holding spaces",
      "From: a@x\r\nSubject: Hi\r\n \r\nSECRET body",
    ],
    ["bare CR line ends", "From: a@x\rSubject: Hi\r\rSECRET body"],
    ["no blank line at all", "From: a@x\r\nSubject: Hi\r\nSECRET body"],
  ])("leaves the body out with %s", (_case, raw) => {
    expect(headerBlock(Buffer.from(raw))).not.toContain("SECRET");
  });

  it("keeps folded header lines", () => {
    expect(
      headerBlock(Buffer.from("Subject: a\r\n long one\r\n\r\nbody")),
    ).toBe("Subject: a\r\n long one");
  });

  it("reads raw Latin-1 headers", () => {
    expect(
      headerBlock(Buffer.from("Subject: Gr\u00fc\u00dfe\r\n\r\n", "latin1")),
    ).toBe("Subject: Grüße");
  });
});

describe("parseSieveSuggestions", () => {
  it("leaves out a suggestion the app could not send back", () => {
    expect(
      parseSieveSuggestions({
        suggestions: [
          {
            id: "list-id",
            label: "Long list",
            condition: {
              kind: "header",
              header: "list-id",
              value: "x".repeat(600),
            },
          },
          {
            id: "from",
            label: "Sender",
            condition: { kind: "address", header: "from", value: "a@x" },
          },
        ],
      }).map(({ id }) => id),
    ).toEqual(["from"]);
  });
});

describe("callSieveTool", () => {
  it("asks for a Sieve server when none is connected", async () => {
    prisma.mcpConnection.findFirst.mockResolvedValue(null);

    await expect(
      callSieveTool({
        emailAccountId: "a",
        tool: "suggest_rule",
        args: {},
        logger,
      }),
    ).rejects.toThrow("Connect a Sieve server");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("passes on what the server refused as plain text", async () => {
    prisma.mcpConnection.findFirst.mockResolvedValue({
      name: "Sieve Buddy",
      integration: { name: "custom_sieve" },
    } as never);
    callTool.mockResolvedValue({
      isError: true,
      content: [
        { type: "text", text: "The filter was changed in the meantime" },
      ],
    });

    await expect(
      callSieveTool({
        emailAccountId: "a",
        tool: "apply_rule",
        args: {},
        logger,
      }),
    ).rejects.toThrow("The filter was changed in the meantime");
  });
});

describe("toMessages", () => {
  it("turns the server's notes and line errors into text", () => {
    expect(
      toMessages(["A note", { line: 3, message: "Unknown folder" }]),
    ).toEqual(["A note", "Line 3: Unknown folder"]);
  });
});
