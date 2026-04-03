import { encode } from "@commontools/utils/encoding";

function stringify(value: unknown): string {
  switch (typeof value) {
    case "object": {
      if (!value) return "null";
      if (
        value instanceof ArrayBuffer ||
        ("buffer" in value && value.buffer instanceof ArrayBuffer)
      ) {
        // All commands operate over text rather than binary
        throw new Error("Binary data could not be stringified");
      }
      try {
        return JSON.stringify(value, null, 2);
        // deno-lint-ignore no-empty
      } catch (_) {}
      return value.toString();
    }
    case "function":
      throw new Error("Function could not be stringified");
    case "symbol":
      return value.toString();
    case "undefined":
    case "string":
    case "number":
    case "boolean":
    case "bigint":
    default:
      return `${value}`;
  }
}

export function render(value: unknown, { json }: { json?: boolean } = {}) {
  if (json) {
    // For JSON mode, output raw JSON without additional formatting
    const jsonValue = `${safeStringify(value)}\n`;
    Deno.stdout.writeSync(encode(jsonValue));
    return;
  }
  // Append a `\n` to the stdout for TTY legibility and
  // unix file compatibility.
  const stringValue = `${stringify(value)}\n`;
  Deno.stdout.writeSync(encode(stringValue));
}

// Helper function to safely stringify objects with circular references
export function safeStringify(obj: unknown, maxDepth = 8): string {
  const seen = new WeakSet();

  const stringify = (value: unknown, depth = 0): unknown => {
    if (depth > maxDepth) {
      return "<max depth reached>";
    }

    if (value === null || typeof value !== "object") {
      return value;
    }

    if (seen.has(value)) {
      return "<circular reference>";
    }

    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => stringify(item, depth + 1));
    }

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = stringify(val, depth + 1);
    }

    return result;
  };

  try {
    return JSON.stringify(stringify(obj), null, 2);
  } catch (error) {
    return `<error stringifying object: ${(error as Error)?.message}>`;
  }
}
