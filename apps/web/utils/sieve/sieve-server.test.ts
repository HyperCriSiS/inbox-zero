import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { SafeError } from "@/utils/error";
import { callSieveTool, headerBlock, toMessages } from "./sieve-server";

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

  it("does not save a rule while the apply tool is switched off", async () => {
    prisma.mcpConnection.findFirst.mockResolvedValue({
      integration: { name: "custom_sieve" },
      tools: [{ isEnabled: false }],
    } as never);

    await expect(
      callSieveTool({
        emailAccountId: "a",
        tool: "apply_rule",
        args: {},
        logger,
      }),
    ).rejects.toBeInstanceOf(SafeError);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("passes on what the server refused as plain text", async () => {
    prisma.mcpConnection.findFirst.mockResolvedValue({
      integration: { name: "custom_sieve" },
      tools: [{ isEnabled: true }],
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
