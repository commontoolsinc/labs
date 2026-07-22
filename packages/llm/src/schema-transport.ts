// Guards a generated schema against the one lossy step between the runner and
// an external LLM provider: the request is sent as ordinary JSON, so any value
// the schema carries that plain JSON cannot represent faithfully reaches the
// provider altered, or not at all.
//
// The Common Fabric schema/value model is a superset of JSON. A schema may
// legitimately hold a non-finite number or a signed zero as a `default` (or a
// `const`, an `examples` entry, a `minimum`, ...). Those are fine internally.
// But `JSON.stringify` renders `NaN` and `±Infinity` as `null`, drops the sign
// of `-0`, and throws outright on a `bigint`. A provider would then validate or
// enforce a schema subtly different from the one the author wrote -- silently.
//
// This is deliberately a boundary check, not a schema fix. The narrowing
// belongs to the external consumer, not to the schema generator, which keeps
// the value faithfully. Here the policy is to refuse: a value that cannot be
// sent without alteration is reported rather than quietly changed.

/** A value plain JSON serialization cannot carry faithfully, and where it sits. */
export interface JsonUnsafeValue {
  /** Dotted / bracketed path from the schema root, e.g. `properties.n.default`. */
  readonly path: string;
  /** How the offending value reads, e.g. `NaN`, `-0`, `-Infinity`, `42n`. */
  readonly description: string;
}

function describe(value: number | bigint): string {
  if (typeof value === "bigint") return `${value}n`;
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Object.is(value, -0)) return "-0";
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collect(value: unknown, path: string, out: JsonUnsafeValue[]): void {
  if (typeof value === "bigint") {
    out.push({ path, description: describe(value) });
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      out.push({ path, description: describe(value) });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collect(item, `${path}[${i}]`, out));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      collect(child, path ? `${path}.${key}` : key, out);
    }
  }
}

/**
 * Find every value in `schema` that ordinary JSON serialization would alter or
 * reject: a non-finite number, a signed zero, or a bigint, anywhere in the
 * graph. Returns them with their paths; an empty array means the schema is
 * safe to send as JSON.
 */
export function findJsonUnsafeSchemaValues(
  schema: Record<string, unknown>,
): JsonUnsafeValue[] {
  const out: JsonUnsafeValue[] = [];
  collect(schema, "", out);
  return out;
}

/**
 * Throw if `schema` holds any value ordinary JSON serialization cannot carry
 * faithfully. The message names each offending value and its path, so the
 * author can see which annotation to change rather than discovering a mangled
 * default downstream in the provider's behavior.
 */
export function assertSchemaJsonTransportSafe(
  schema: Record<string, unknown>,
): void {
  const unsafe = findJsonUnsafeSchemaValues(schema);
  if (unsafe.length === 0) return;

  const lines = unsafe.map(({ path, description }) =>
    `  ${path || "<root>"}: ${description}`
  );
  throw new Error(
    `The generateObject schema holds ${unsafe.length} value(s) that cannot be ` +
      `sent to the LLM provider unaltered:\n${lines.join("\n")}\n` +
      `These are valid Common Fabric values, but the provider receives the ` +
      `schema as ordinary JSON, which renders NaN/±Infinity as null, drops the ` +
      `sign of -0, and cannot represent a bigint. Remove or replace the ` +
      `value(s) above.`,
  );
}
