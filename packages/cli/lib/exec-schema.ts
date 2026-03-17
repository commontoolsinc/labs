import type { JSONSchema } from "@commontools/api";
import { schemaToTypeString } from "../../runner/src/schema-format.ts";

export interface ExecCommandSpec {
  callableKind: "handler" | "tool";
  defaultVerb: "invoke" | "run";
  inputSchema: JSONSchema;
  outputSchemaSummary?: JSONSchema;
}

export interface ParsedExecArgs {
  verb: "invoke" | "run";
  input: unknown;
  showHelp: boolean;
}

interface FlagDescriptor {
  key: string;
  flagName: string;
  schema: JSONSchema;
}

function isSchemaObject(schema: JSONSchema): schema is Record<string, unknown> {
  return typeof schema === "object" && schema !== null && !Array.isArray(schema);
}

function objectProperties(schema: JSONSchema): Record<string, JSONSchema> | null {
  if (!isSchemaObject(schema)) return null;
  if (schema.type !== "object" && !schema.properties) return null;
  const properties = schema.properties;
  if (
    typeof properties !== "object" || properties === null ||
    Array.isArray(properties)
  ) {
    return {};
  }
  return properties as Record<string, JSONSchema>;
}

function requiredFlags(schema: JSONSchema): Set<string> {
  if (!isSchemaObject(schema) || !Array.isArray(schema.required)) {
    return new Set();
  }
  return new Set(schema.required as string[]);
}

function schemaType(schema: JSONSchema): string | undefined {
  return isSchemaObject(schema) ? schema.type as string | undefined : undefined;
}

function flagNameForKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function parseBoolean(value: string, flagName: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid value for ${flagName}: expected true or false`);
}

function parseJson(value: string, flagName: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON for ${flagName}`);
  }
}

function validateEnum(
  value: unknown,
  schema: JSONSchema,
  flagName: string,
): void {
  if (!isSchemaObject(schema) || !Array.isArray(schema.enum)) return;
  if (!schema.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`Invalid value for ${flagName}`);
  }
}

function parseValueForSchema(
  rawValue: string,
  schema: JSONSchema,
  flagName: string,
): unknown {
  const type = schemaType(schema);

  if (type === "boolean") {
    const value = parseBoolean(rawValue, flagName);
    validateEnum(value, schema, flagName);
    return value;
  }

  if (type === "number" || type === "integer") {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid value for ${flagName}: expected ${type}`);
    }
    if (type === "integer" && !Number.isInteger(value)) {
      throw new Error(`Invalid value for ${flagName}: expected integer`);
    }
    validateEnum(value, schema, flagName);
    return value;
  }

  if (type === "array" || type === "object") {
    const value = parseJson(rawValue, flagName);
    if (type === "array" && !Array.isArray(value)) {
      throw new Error(`Invalid value for ${flagName}: expected array JSON`);
    }
    if (
      type === "object" &&
      (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      throw new Error(`Invalid value for ${flagName}: expected object JSON`);
    }
    validateEnum(value, schema, flagName);
    return value;
  }

  if (type === "null") {
    const value = parseJson(rawValue, flagName);
    if (value !== null) {
      throw new Error(`Invalid value for ${flagName}: expected null`);
    }
    return value;
  }

  validateEnum(rawValue, schema, flagName);
  return rawValue;
}

function parseObjectInput(
  schema: JSONSchema,
  args: string[],
): Record<string, unknown> {
  const properties = objectProperties(schema) ?? {};
  const descriptors = new Map<string, FlagDescriptor>();
  for (const [key, propertySchema] of Object.entries(properties)) {
    const flagName = flagNameForKey(key);
    descriptors.set(flagName, { key, flagName, schema: propertySchema });
  }

  const input: Record<string, unknown> = {};
  let usedJson = false;
  let usedGeneratedFlags = false;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument ${token}`);
    }

    if (token === "--json") {
      if (usedGeneratedFlags) {
        throw new Error("--json cannot be combined with generated flags");
      }
      if (usedJson) {
        throw new Error("--json can only be provided once");
      }
      const rawValue = args[i + 1];
      if (rawValue === undefined) {
        throw new Error("Missing value for --json");
      }
      const parsed = parseJson(rawValue, "--json");
      if (
        typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      ) {
        throw new Error("Invalid JSON for --json: expected object");
      }
      Object.assign(input, parsed as Record<string, unknown>);
      usedJson = true;
      i++;
      continue;
    }

    if (usedJson) {
      throw new Error("--json cannot be combined with generated flags");
    }

    const inlineSplit = token.slice(2).split("=", 2);
    const rawFlag = inlineSplit[0];
    const inlineValue = inlineSplit.length === 2 ? inlineSplit[1] : undefined;

    let negated = false;
    let descriptor = descriptors.get(rawFlag);
    if (!descriptor && rawFlag.startsWith("no-")) {
      descriptor = descriptors.get(rawFlag.slice(3));
      negated = descriptor !== undefined;
    }
    if (!descriptor) {
      throw new Error(`Unknown flag --${rawFlag}`);
    }

    const flagName = `--${descriptor.flagName}`;
    const type = schemaType(descriptor.schema);
    if (negated) {
      if (type !== "boolean") {
        throw new Error(`Unknown flag --${rawFlag}`);
      }
      input[descriptor.key] = false;
      usedGeneratedFlags = true;
      continue;
    }

    if (type === "boolean") {
      if (inlineValue !== undefined) {
        input[descriptor.key] = parseBoolean(inlineValue, flagName);
      } else {
        input[descriptor.key] = true;
      }
      usedGeneratedFlags = true;
      continue;
    }

    const rawValue = inlineValue ?? args[i + 1];
    if (rawValue === undefined) {
      throw new Error(`Missing value for ${flagName}`);
    }
    input[descriptor.key] = parseValueForSchema(
      rawValue,
      descriptor.schema,
      flagName,
    );
    usedGeneratedFlags = true;
    if (inlineValue === undefined) {
      i++;
    }
  }

  for (const key of requiredFlags(schema)) {
    if (!(key in input)) {
      throw new Error(`Missing required flag --${flagNameForKey(key)}`);
    }
  }

  return input;
}

function parseNonObjectInput(schema: JSONSchema, args: string[]): unknown {
  if (args.length === 0) return undefined;
  if (args.length > 2) {
    throw new Error(`Unexpected argument ${args[2]}`);
  }

  const [flag, rawValue] = args;
  if (flag !== "--value" && flag !== "--json") {
    throw new Error(`Unknown flag ${flag}`);
  }
  if (rawValue === undefined) {
    throw new Error(`Missing value for ${flag}`);
  }
  if (flag === "--json") {
    return parseJson(rawValue, flag);
  }
  return parseValueForSchema(rawValue, schema, flag);
}

function hasHelpField(schema: JSONSchema): boolean {
  const properties = objectProperties(schema);
  return properties ? "help" in properties : false;
}

function inputSchemaSummary(schema: JSONSchema): string {
  if (schema === true) return "unknown";
  if (schema === false) return "never";
  return schemaToTypeString(schema);
}

export function parseExecArgs(
  spec: ExecCommandSpec,
  rawArgs: string[],
): ParsedExecArgs {
  const args = [...rawArgs];
  let verb = spec.defaultVerb;

  if (rawArgs[0] === "--help") {
    return { verb, input: {}, showHelp: true };
  }

  if (args[0] === "invoke" || args[0] === "run") {
    if (args[0] !== spec.defaultVerb) {
      throw new Error(
        `Invalid verb ${args[0]} for ${spec.callableKind}; use ${spec.defaultVerb}`,
      );
    }
    verb = args.shift() as "invoke" | "run";
  }

  if (args[0] === "--help" && !hasHelpField(spec.inputSchema)) {
    return { verb, input: {}, showHelp: true };
  }

  const properties = objectProperties(spec.inputSchema);
  const input = properties
    ? parseObjectInput(spec.inputSchema, args)
    : parseNonObjectInput(spec.inputSchema, args);

  return {
    verb,
    input: input ?? {},
    showHelp: false,
  };
}

export function renderExecHelp(
  mountedFilePath: string,
  spec: ExecCommandSpec,
): string {
  const lines = [
    `Usage: ct exec ${mountedFilePath} [${spec.defaultVerb}] [flags]`,
    `Callable: ${spec.callableKind}`,
    `Verb: ${spec.defaultVerb}`,
    `Input: ${inputSchemaSummary(spec.inputSchema)}`,
  ];

  if (spec.callableKind === "tool" && spec.outputSchemaSummary !== undefined) {
    lines.push(`Output: ${inputSchemaSummary(spec.outputSchemaSummary)}`);
  }

  return lines.join("\n");
}
