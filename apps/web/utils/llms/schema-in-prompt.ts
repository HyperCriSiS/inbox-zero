import {
  APICallError,
  asSchema,
  type FlexibleSchema,
  RetryError,
  TypeValidationError,
} from "ai";

// Providers that compile the schema into a decoding grammar reject large ones:
// Anthropic caps optional parameters at 24, and llama.cpp, vLLM and LM Studio
// fail on schema nodes their converters do not know.
const SCHEMA_TOO_COMPLEX_PATTERNS = [
  /too many optional parameters/i,
  /grammar compilation/i,
  /grammar is too large/i,
  /schema is too complex/i,
  /json schema conversion failed/i,
  /unrecognized schema/i,
];

export function isSchemaTooComplexError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    seen.add(current);

    const texts: string[] = [];
    if (current instanceof Error) texts.push(current.message);
    if (APICallError.isInstance(current) && current.responseBody) {
      texts.push(current.responseBody);
    }
    if (
      texts.some((text) =>
        SCHEMA_TOO_COMPLEX_PATTERNS.some((pattern) => pattern.test(text)),
      )
    ) {
      return true;
    }

    current = RetryError.isInstance(current)
      ? current.lastError
      : current instanceof Error
        ? current.cause
        : undefined;
  }

  return false;
}

type SchemaRequest = {
  schema?: FlexibleSchema<unknown>;
  schemaName?: string;
  schemaDescription?: string;
  output?: string;
  prompt?: unknown;
  instructions?: unknown;
};

export function canMoveSchemaToPrompt(request: SchemaRequest): boolean {
  if (!request.schema) return false;
  if (request.output && request.output !== "object") return false;
  return (
    typeof request.prompt === "string" ||
    typeof request.instructions === "string"
  );
}

// Asks for plain JSON with the schema spelled out in the prompt, so the
// provider never compiles it. The result is validated against the schema here.
export async function buildSchemaInPromptRequest<T extends SchemaRequest>(
  request: T,
) {
  const schema = asSchema(request.schema);
  const jsonSchema = await Promise.resolve(schema.jsonSchema);
  const schemaText = [
    "Respond with a single JSON object only, no prose and no markdown.",
    "It must match this JSON schema:",
    JSON.stringify(jsonSchema),
  ].join("\n");

  const {
    schema: _schema,
    schemaName: _schemaName,
    schemaDescription: _schemaDescription,
    ...rest
  } = request;

  const withSchemaText =
    typeof request.prompt === "string"
      ? { prompt: `${request.prompt}\n\n${schemaText}` }
      : { instructions: `${request.instructions}\n\n${schemaText}` };

  return { ...rest, ...withSchemaText, output: "no-schema" as const };
}

export async function validateAgainstSchema<RESULT>(
  schema: FlexibleSchema<unknown>,
  value: unknown,
): Promise<RESULT> {
  const resolved = asSchema(schema);
  if (!resolved.validate) return value as RESULT;

  const result = await resolved.validate(value);
  if (!result.success) {
    throw new TypeValidationError({ value, cause: result.error });
  }
  return result.value as RESULT;
}
