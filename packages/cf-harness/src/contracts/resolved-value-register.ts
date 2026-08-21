/**
 * The run's register of values a handle has been materialized into, and the
 * scrub that keeps them out of everything the model reads afterwards.
 *
 * A backstop against accidental echo, not a containment boundary. Resolving
 * a handle trusted-side is defeated outright if the value comes straight
 * back — a page echoes what was typed into it, a later snapshot reads the
 * filled field, a nonzero exit puts the argument list in stderr — so a tool
 * that materializes a value records it here and model-facing strings are
 * scrubbed through the register.
 *
 * Read the limit honestly. This matches strings, so it catches a value
 * returned as it was written and misses one the page transformed: HTML
 * entities, JSON escaping, a case change, or a value split across two
 * elements all pass through. It raises the cost of the obvious return path;
 * it does not close the class. Containment that holds has to come from the
 * labels on the data governing the read, not from recognizing the bytes.
 *
 * The register is run-scoped and in-memory only. It holds the very values the
 * design exists to keep out of the model's context, so it is never written to
 * run state, a transcript, or an artifact.
 */
export const RESOLVED_VALUE_PLACEHOLDER = "<withheld value>";

export interface HarnessResolvedValueRegister {
  /**
   * Adds a materialized value to the register. An empty string is ignored:
   * it matches everywhere and would scrub text that never carried it.
   */
  record(value: string): void;
  /** `text` with every registered value replaced by the placeholder. */
  scrub(text: string): string;
  /** How many distinct values the run has materialized. */
  readonly size: number;
}

/**
 * The forms a registered value can reappear in. A value typed into a form
 * comes back raw in a snapshot, percent-encoded in a submitted URL, and
 * form-encoded when the submission used `application/x-www-form-urlencoded`.
 */
const echoForms = (value: string): readonly string[] => {
  const encoded = encodeURIComponent(value);
  return [...new Set([value, encoded, encoded.replaceAll("%20", "+")])];
};

export const createHarnessResolvedValueRegister =
  (): HarnessResolvedValueRegister => {
    const forms = new Set<string>();
    let recorded = 0;
    return {
      record(value: string) {
        if (value === "") {
          return;
        }
        recorded += 1;
        for (const form of echoForms(value)) {
          forms.add(form);
        }
      },
      scrub(text: string): string {
        if (forms.size === 0) {
          return text;
        }
        // Longest first, so a value that contains another is replaced whole
        // rather than left as a placeholder embedded in the rest of it.
        return [...forms]
          .sort((left, right) => right.length - left.length)
          .reduce(
            (scrubbed, form) =>
              scrubbed.replaceAll(form, RESOLVED_VALUE_PLACEHOLDER),
            text,
          );
      },
      get size() {
        return recorded;
      },
    };
  };

/**
 * `value` with every registered value scrubbed out of every string it
 * contains, including object keys.
 *
 * A tool that materializes a value can only scrub what it prints itself. The
 * value reaches a page, and any tool that later reads that page — a skill
 * script driving the same browser, a shell command fetching the same URL —
 * would carry it back untouched. Applying this at the one boundary every tool
 * output crosses on its way to the model closes that class of return path
 * rather than one tool at a time.
 */
export const scrubResolvedValuesDeep = (
  register: HarnessResolvedValueRegister | undefined,
  value: unknown,
): unknown => {
  if (register === undefined || register.size === 0) {
    return value;
  }
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") {
      return register.scrub(input);
    }
    if (Array.isArray(input)) {
      return input.map(walk);
    }
    if (typeof input === "object" && input !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(input)) {
        result[register.scrub(key)] = walk(entry);
      }
      return result;
    }
    return input;
  };
  return walk(value);
};
