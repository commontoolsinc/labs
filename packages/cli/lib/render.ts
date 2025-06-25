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
    const jsonValue = `${JSON.stringify(value, null, 2)}\n`;
    Deno.stdout.write(encode(jsonValue));
    return;
  }
  // Append a `\n` to the stdout for TTY legibility and
  // unix file compatibility.
  const stringValue = `${stringify(value)}\n`;
  Deno.stdout.write(encode(stringValue));
}
