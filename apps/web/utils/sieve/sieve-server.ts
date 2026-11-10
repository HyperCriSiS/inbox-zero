import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { sieveConditionSchema } from "@/utils/actions/sieve.validation";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import { resolveMcpIntegration } from "@/utils/mcp/resolve-integration";
import { getMcpServerConnection } from "@/utils/mcp/server-connection";
import { createMcpTransport } from "@/utils/mcp/transport";
import prisma from "@/utils/prisma";

// A connected MCP server counts as a Sieve server when it offers these tools,
// as Sieve Buddy does. Nothing else about the server is assumed.
const REQUIRED_TOOLS = ["suggest_rule", "plan_rule", "list_folders"];
const APPLY_TOOL = "apply_rule";

export async function getSieveServer(emailAccountId: string) {
  const connection = await prisma.mcpConnection.findFirst({
    where: {
      emailAccountId,
      isActive: true,
      AND: REQUIRED_TOOLS.map((name) => ({ tools: { some: { name } } })),
    },
    select: {
      integration: { select: { name: true } },
      tools: { where: { name: APPLY_TOOL }, select: { isEnabled: true } },
    },
  });
  if (!connection) return null;
  return {
    integrationName: connection.integration.name,
    // Saving changes the user's live mail filters, so it follows the tool's
    // switch under Integrations like any other write tool.
    canApply: connection.tools.some((tool) => tool.isEnabled),
  };
}

export async function callSieveTool({
  emailAccountId,
  tool,
  args,
  logger,
}: {
  emailAccountId: string;
  tool: "suggest_rule" | "list_folders" | "plan_rule" | "apply_rule";
  args: Record<string, unknown>;
  logger: Logger;
}): Promise<unknown> {
  const server = await getSieveServer(emailAccountId);
  if (!server) {
    throw new SafeError("Connect a Sieve server under Integrations first.");
  }
  if (tool === APPLY_TOOL && !server.canApply) {
    throw new SafeError(
      "Turn on the apply_rule tool of your Sieve server under Integrations to save rules.",
    );
  }

  const integration = await resolveMcpIntegration({
    name: server.integrationName,
    emailAccountId,
  });
  if (!integration) throw new SafeError("The Sieve server is not available.");

  const transport = createMcpTransport(
    await getMcpServerConnection(integration, emailAccountId),
  );
  const client = new Client({ name: "inbox-zero-sieve", version: "1.0.0" });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args });
    const text = toolText(result.content);
    if (result.isError) {
      // The user's own server explains what it refused, such as a script that
      // changed in the meantime. It is shown as plain text, never as markup.
      throw new SafeError(
        `The Sieve server refused: ${text.slice(0, 500) || "unknown error"}`,
      );
    }
    return result.structuredContent ?? JSON.parse(text);
  } catch (error) {
    if (error instanceof SafeError) throw error;
    logger.warn("Sieve server call failed", { tool, error });
    throw new SafeError("Could not reach the Sieve server.");
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Mail headers only: the body never leaves the app for a filter suggestion. */
export function headerBlock(source: Buffer) {
  const raw = source.subarray(0, MAX_HEADER_BYTES).toString("utf8");
  const end = raw.search(/\r?\n\r?\n/);
  return end === -1 ? raw : raw.slice(0, end);
}

const MAX_HEADER_BYTES = 64 * 1024;

// The server's answers are data from another program, so they are reduced to
// what the dialog shows instead of being passed through.
export const sieveSuggestionsSchema = z.object({
  suggestions: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      condition: sieveConditionSchema,
    }),
  ),
});

export const sieveFoldersSchema = z.object({
  folders: z.array(z.string()).nullable(),
  labels: z.array(z.string()).nullable().optional(),
  system: z.array(z.string()).optional(),
});

export const sievePlanSchema = z.object({
  description: z.string().optional(),
  target: z.object({ name: z.string(), newFilter: z.boolean().optional() }),
  notes: z.array(z.unknown()).optional(),
  conflicts: z.array(z.unknown()).optional(),
  errors: z.array(z.unknown()).optional(),
  diff: z.object({ text: z.string() }).optional(),
  result: z
    .object({
      location: z.string().nullish(),
      folders: z.array(z.string()).nullish(),
    })
    .nullish(),
});

export const sieveApplySchema = sievePlanSchema.extend({
  saved: z.boolean(),
  reason: z.string().optional(),
});

export function toMessages(items: unknown[] | undefined) {
  return (items ?? []).map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && "message" in item) {
      const { message, line } = item as { message: unknown; line?: unknown };
      return typeof line === "number"
        ? `Line ${line}: ${String(message)}`
        : String(message);
    }
    return JSON.stringify(item);
  });
}

function toolText(content: unknown) {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part && typeof part === "object" && part.type === "text"
        ? [String(part.text)]
        : [],
    )
    .join("\n");
}
