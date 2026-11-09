import { APICallError, jsonSchema, RetryError, TypeValidationError } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildSchemaInPromptRequest,
  canMoveSchemaToPrompt,
  isSchemaTooComplexError,
  validateAgainstSchema,
} from "./schema-in-prompt";

function apiError(responseBody: string) {
  return new APICallError({
    message: "Bad Request",
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode: 400,
    responseBody,
  });
}

describe("isSchemaTooComplexError", () => {
  it("detects the Anthropic optional parameter limit in the response body", () => {
    const error = apiError(
      '{"error":{"message":"Schemas contains too many optional parameters (87), which would make grammar compilation inefficient."}}',
    );
    expect(isSchemaTooComplexError(error)).toBe(true);
  });

  it("detects llama.cpp schema conversion failures", () => {
    const error = new Error(
      'JSON schema conversion failed: Unrecognized schema: {"description":"x"}',
    );
    expect(isSchemaTooComplexError(error)).toBe(true);
  });

  it("looks inside retry errors", () => {
    const error = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [apiError("too many optional parameters")],
    });
    expect(isSchemaTooComplexError(error)).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isSchemaTooComplexError(apiError("rate limit exceeded"))).toBe(
      false,
    );
    expect(isSchemaTooComplexError(undefined)).toBe(false);
  });
});

describe("canMoveSchemaToPrompt", () => {
  const schema = z.object({ name: z.string() });

  it("needs a schema and a text prompt", () => {
    expect(canMoveSchemaToPrompt({ schema, prompt: "hi" })).toBe(true);
    expect(canMoveSchemaToPrompt({ schema, instructions: "hi" })).toBe(true);
    expect(canMoveSchemaToPrompt({ prompt: "hi" })).toBe(false);
    expect(canMoveSchemaToPrompt({ schema })).toBe(false);
  });

  it("skips arrays and enums", () => {
    expect(
      canMoveSchemaToPrompt({ schema, prompt: "hi", output: "array" }),
    ).toBe(false);
  });
});

describe("buildSchemaInPromptRequest", () => {
  it("drops the schema and spells it out in the prompt", async () => {
    const request = await buildSchemaInPromptRequest({
      schema: z.object({ name: z.string() }),
      schemaName: "person",
      prompt: "Who wrote this?",
      instructions: "Be brief.",
    });

    expect(request).not.toHaveProperty("schema");
    expect(request).not.toHaveProperty("schemaName");
    expect(request.output).toBe("no-schema");
    expect(request.instructions).toBe("Be brief.");
    expect(request.prompt).toContain("Who wrote this?");
    expect(request.prompt).toContain('"name"');
  });

  it("uses the instructions when there is no text prompt", async () => {
    const request = await buildSchemaInPromptRequest({
      schema: z.object({ name: z.string() }),
      instructions: "Extract the name.",
    });

    expect(request.instructions).toContain("Extract the name.");
    expect(request.instructions).toContain("JSON schema");
  });
});

describe("validateAgainstSchema", () => {
  const schema = z.object({ count: z.number().default(1) });

  it("returns the parsed value", async () => {
    await expect(validateAgainstSchema(schema, {})).resolves.toEqual({
      count: 1,
    });
  });

  it("refuses a schema that cannot validate the answer", async () => {
    await expect(
      validateAgainstSchema(jsonSchema({ type: "object" }), { any: "thing" }),
    ).rejects.toSatisfy((error) => TypeValidationError.isInstance(error));
  });

  it("throws a type validation error on a mismatch", async () => {
    await expect(
      validateAgainstSchema(schema, { count: "many" }),
    ).rejects.toSatisfy((error) => TypeValidationError.isInstance(error));
  });
});
