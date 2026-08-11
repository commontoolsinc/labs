/**
 * Reading and rendering the record an `assert(...)` test assertion carries.
 *
 * Both `cf test` runners evaluate an assertion step to a value and report a
 * failure from it, so the recognition and the rendering live here rather than
 * in either runner.
 */

import type { AssertPart, AssertRecord } from "@commonfabric/api";

/**
 * Recognizes the record an `assert(...)` assertion carries. A `computed(...)`
 * assertion carries a bare boolean instead, so this is what tells the two
 * apart at the point the harness reads the value.
 */
export function asAssertRecord(value: unknown): AssertRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<AssertRecord>;
  if (
    typeof candidate.ok !== "boolean" ||
    typeof candidate.source !== "string" ||
    !Array.isArray(candidate.parts)
  ) {
    return undefined;
  }
  const parts = candidate.parts.filter((part): part is AssertPart =>
    typeof part === "object" && part !== null &&
    typeof (part as Partial<AssertPart>).src === "string" &&
    typeof (part as Partial<AssertPart>).rendered === "string"
  );
  return { ok: candidate.ok, source: candidate.source, parts };
}

/**
 * Renders a failed `assert(...)` as its authored text followed by the operands
 * recorded while it ran, for example:
 *
 *     a + b <= c
 *       a + b = 3
 *       c     = 2
 *
 * The operands say the assertion was false, so saying it again adds nothing.
 * An assertion that recorded none — a bare value, or one whose operands are
 * all literals — has nothing to explain itself with, so that one still reports
 * what happened rather than restating the source on its own.
 */
export function formatAssertRecord(record: AssertRecord): string {
  if (record.parts.length === 0) {
    return record.source.length > 0
      ? `Expected true, got false: ${record.source}`
      : "Expected true, got false";
  }

  const width = Math.max(...record.parts.map((part) => part.src.length));
  const lines = record.parts.map((part) =>
    `  ${part.src.padEnd(width)} = ${part.rendered}`
  );
  return [record.source, ...lines].join("\n");
}
