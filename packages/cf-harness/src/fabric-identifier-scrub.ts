/**
 * Replaces bare fabric identifiers in model-facing or retrospective text with
 * a fixed placeholder. Schemed links and harness handle tokens remain intact.
 */
export const scrubBareFabricIdentifiers = (text: string): string =>
  text
    .replaceAll(/\bdata:[^\s"'`)\]}]+/gi, "[fabric-id]")
    .replaceAll(/\bdid:[a-z0-9]+:[A-Za-z0-9._%-]+/g, "[fabric-id]")
    .replaceAll(
      /(?<![A-Za-z0-9:])[A-Za-z0-9]+:[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
      "[fabric-id]",
    );

/**
 * Applies the bare-identifier scrub to every string and object key in a value.
 * A key that becomes indistinguishable from a sibling is overwritten because
 * the model-facing or retrospective boundary cannot distinguish it either.
 */
export const scrubBareFabricIdentifiersDeep = (value: unknown): unknown => {
  if (typeof value === "string") {
    return scrubBareFabricIdentifiers(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrubBareFabricIdentifiersDeep(entry));
  }
  if (typeof value === "object" && value !== null) {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(scrubbed, scrubBareFabricIdentifiers(key), {
        value: scrubBareFabricIdentifiersDeep(entry),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return scrubbed;
  }
  return value;
};
