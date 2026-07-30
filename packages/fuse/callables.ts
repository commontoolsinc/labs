import type { JSONSchema } from "@commonfabric/api";
import {
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import {
  jsonFromValue,
  seemsLikeJsonEncodedFabricValue,
  valueFromJson,
} from "@commonfabric/data-model/codec-json";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";

const encoder = new TextEncoder();

export type CallableKind = "handler" | "tool";

export function patternFactoryFromCallableEntry(
  value: unknown,
): unknown | undefined {
  if (isAdmittedFabricFactory(value)) {
    return factoryStateOf(value).kind === "pattern" ? value : undefined;
  }
  if (
    typeof value === "object" && value !== null && !Array.isArray(value)
  ) {
    const pattern = (value as Record<string, unknown>).pattern;
    if (
      isAdmittedFabricFactory(pattern) &&
      factoryStateOf(pattern).kind === "pattern"
    ) {
      return pattern;
    }
  }
  return undefined;
}

export function patternFactorySchemas(value: unknown): {
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
} | undefined {
  const factory = patternFactoryFromCallableEntry(value);
  if (!isAdmittedFabricFactory(factory)) return undefined;
  const state = factoryStateOf(factory);
  return state.kind === "pattern"
    ? {
      argumentSchema: state.argumentSchema,
      resultSchema: state.resultSchema,
    }
    : undefined;
}

export function patternFactorySchemasFromSchema(
  schema: JSONSchema | undefined,
): {
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
} | undefined {
  if (!isSchemaRecord(schema)) return undefined;
  const direct = schema.asFactory;
  if (direct?.kind === "pattern") {
    return {
      argumentSchema: direct.argumentSchema,
      resultSchema: direct.resultSchema,
    };
  }

  const properties = schema.properties;
  if (!isSchemaRecord(properties)) return undefined;
  const pattern = properties.pattern;
  if (!isSchemaRecord(pattern) || pattern.asFactory?.kind !== "pattern") {
    return undefined;
  }
  return {
    argumentSchema: pattern.asFactory.argumentSchema,
    resultSchema: pattern.asFactory.resultSchema,
  };
}

export function encodeFactoryProjection(value: unknown): string | undefined {
  return isAdmittedFabricFactory(value)
    ? jsonFromValue(value as FabricValue)
    : undefined;
}

/**
 * Decode an explicit `fvj1:` factory projection to a context-free shell.
 *
 * The prefix is reserved by the FUSE file projection. A literal authored
 * string with that prefix must be stored through another interface;
 * silently treating a malformed tagged value as text would make a read/write
 * echo corrupt factory-bearing JSON.
 */
export function decodeFactoryProjection(value: unknown): unknown | undefined {
  if (
    typeof value !== "string" || !seemsLikeJsonEncodedFabricValue(value)
  ) {
    return undefined;
  }
  const decoded = valueFromJson(value);
  if (!isAdmittedFabricFactory(decoded)) {
    throw new TypeError("Tagged FUSE callable value is not a Factory@1");
  }
  return decoded;
}

/** Parse a handler file payload while keeping tagged-value failures explicit. */
export function decodeHandlerWritePayload(text: string): unknown {
  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Bare strings remain convenient for shell callers such as
    // `echo book > addItem.handler`.
    return trimmed;
  }
  return decodeFactoryProjections(parsed);
}

/** Decode tagged factory leaves without reinterpreting ordinary JSON values. */
export function decodeFactoryProjections(value: unknown): unknown {
  const direct = decodeFactoryProjection(value);
  if (direct !== undefined) return direct;
  if (Array.isArray(value)) {
    let result: unknown[] | undefined;
    for (let index = 0; index < value.length; index++) {
      const child = value[index];
      const decoded = decodeFactoryProjections(child);
      if (!Object.is(decoded, child)) {
        result ??= [...value];
        result[index] = decoded;
      }
    }
    return result ?? value;
  }
  if (typeof value === "object" && value !== null) {
    let result: Record<string, unknown> | undefined;
    for (const [key, child] of Object.entries(value)) {
      const decoded = decodeFactoryProjections(child);
      if (!Object.is(decoded, child)) {
        result ??= { ...(value as Record<string, unknown>) };
        result[key] = decoded;
      }
    }
    return result ?? value;
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isSchemaRecord(schema: JSONSchema | undefined): schema is Record<
  string,
  unknown
> {
  return typeof schema === "object" && schema !== null &&
    !Array.isArray(schema);
}

export function isStreamValue(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return "$stream" in obj && obj.$stream === true;
}

export function isHandlerCell(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const cell = v as { isStream?: () => boolean };
  if (typeof cell.isStream === "function") {
    try {
      return cell.isStream();
    } catch {
      return false;
    }
  }
  return false;
}

export function isPatternFactoryValue(v: unknown): boolean {
  return patternFactoryFromCallableEntry(v) !== undefined;
}

export function isPatternFactorySchema(
  schema: JSONSchema | undefined,
): boolean {
  return patternFactorySchemasFromSchema(schema) !== undefined;
}

export function classifyCallableEntry(
  value: unknown,
  schema?: JSONSchema,
): CallableKind | null {
  if (patternFactoryFromCallableEntry(value) !== undefined) {
    return "tool";
  }
  if (isPatternFactorySchema(schema)) {
    return "tool";
  }

  if (isStreamValue(value) || isHandlerCell(value)) {
    return "handler";
  }

  if (schema === undefined && isPatternFactoryValue(value)) {
    return "tool";
  }

  return null;
}

export function buildCallableScript(
  execCli: string,
  schema?: JSONSchema,
  typeStr?: string,
): Uint8Array {
  const shim = execCli || "/usr/bin/false";
  // Comments are readable via `cat` and `head`; cf exec handles --help and
  // flag-based invocation (--value <x> for scalars, --flag <v> for objects).
  const schemaComment = schema !== undefined
    ? `# schema: ${JSON.stringify(schema)}\n`
    : "";
  const typeComment = typeStr !== undefined
    ? `# input: ${typeStr.replaceAll("\n", "\n# ")}\n`
    : "";
  return encoder.encode(
    `#!${shim} exec\n${schemaComment}${typeComment}exec ${
      shellQuote(shim)
    } exec "$0" "$@"\n`,
  );
}

export function transformCallableValues(
  value: unknown,
  classify: (key: string, value: unknown) => CallableKind | null = (
    _key,
    candidate,
  ) => classifyCallableEntry(candidate),
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const obj = value as Record<string, unknown>;
  let hasCallables = false;
  for (const [key, candidate] of Object.entries(obj)) {
    if (classify(key, candidate)) {
      hasCallables = true;
      break;
    }
  }
  if (!hasCallables) return value;

  const result: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(obj)) {
    const callableKind = classify(key, candidate);
    if (callableKind) {
      result[key] = callableKind === "handler"
        ? { "/handler": key }
        : { "/tool": key };
    } else {
      result[key] = candidate;
    }
  }

  return result;
}
