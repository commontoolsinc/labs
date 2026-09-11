import type { Pattern } from "@commonfabric/runner";

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * The verified writer binding a pattern declares for the command queue it
 * sends to, read from the `commandAuthorization` field of its result schema.
 * Returns `undefined` for a pattern that declares none.
 */
export function commandWriterAuthorization(
  pattern: Pattern,
): unknown | undefined {
  const root = recordValue(pattern.resultSchema);
  const properties = recordValue(root?.properties);
  let authorization = recordValue(properties?.commandAuthorization);
  const reference = authorization?.$ref;
  if (typeof reference === "string" && reference.startsWith("#/$defs/")) {
    const definitions = recordValue(root?.$defs);
    authorization = recordValue(
      definitions?.[decodeURIComponent(reference.slice("#/$defs/".length))],
    );
  }
  const ifc = recordValue(authorization?.ifc);
  const writers = ifc?.writeAuthorizedBy;
  return writers === null ? undefined : writers;
}
