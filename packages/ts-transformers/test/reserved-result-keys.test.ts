import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import ts from "typescript";

import type { DiagnosticInput } from "../src/core/mod.ts";
import { reportOpaqueReservedResultKeys } from "../src/transformers/reserved-result-keys.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { validateSource } from "./utils.ts";

const DIAGNOSTIC_TYPE = "pattern-result:opaque-reserved-key";

/** The diagnostics one schema draws, reported straight rather than compiled. */
function diagnosticsFor(schema: unknown): DiagnosticInput[] {
  const reported: DiagnosticInput[] = [];
  reportOpaqueReservedResultKeys(
    { reportDiagnosticOnce: (input) => void reported.push(input) },
    schema,
    ts.factory.createIdentifier("anchor"),
  );
  return reported;
}

/** A result schema whose root is a reference to the one definition it holds. */
function rootRef(ref: string, definition?: unknown): Record<string, unknown> {
  return {
    $ref: ref,
    ...(definition === undefined ? {} : { $defs: { Held: definition } }),
  };
}

const OPAQUE_SCREEN = {
  type: "object",
  properties: { $UI: { type: "unknown" }, label: { type: "string" } },
} as const;

/** The reserved-key diagnostics a source produces, in emission order. */
async function reservedKeyDiagnostics(lines: string[]) {
  const { diagnostics } = await validateSource(lines.join("\n"), {
    types: COMMONFABRIC_TYPES,
  });
  const unexpected = diagnostics.filter((d) =>
    d.severity === "error" && d.type !== DIAGNOSTIC_TYPE
  );
  expect(unexpected.map((d) => `${d.type}: ${d.message}`)).toEqual([]);
  return diagnostics.filter((d) => d.type === DIAGNOSTIC_TYPE);
}

describe("reserved-result-keys", () => {
  describe("reportOpaqueReservedResultKeys()", () => {
    it("ignores a schema that describes no properties", () => {
      expect(diagnosticsFor(true)).toEqual([]);
      expect(diagnosticsFor(null)).toEqual([]);
      expect(diagnosticsFor([OPAQUE_SCREEN])).toEqual([]);
      expect(diagnosticsFor({ type: "object" })).toEqual([]);
    });

    it("follows a root reference into the definition it names", () => {
      const reported = diagnosticsFor(
        rootRef("#/$defs/Held", OPAQUE_SCREEN),
      );
      expect(reported.length).toBe(1);
      expect(reported[0]!.message).toContain("`$UI`");
    });

    it("follows a chain of root references", () => {
      expect(
        diagnosticsFor({
          $ref: "#/$defs/Outer",
          $defs: { Outer: { $ref: "#/$defs/Held" }, Held: OPAQUE_SCREEN },
        }).length,
      ).toBe(1);
    });

    it("leaves a root reference it cannot resolve alone", () => {
      // An external reference, one with no definitions to resolve against, one
      // naming a definition that is not there, and one that names itself.
      expect(diagnosticsFor(rootRef("https://example.test/vnode.json")))
        .toEqual(
          [],
        );
      expect(diagnosticsFor({ $ref: "#/$defs/Held" })).toEqual([]);
      expect(diagnosticsFor(rootRef("#/$defs/Absent", OPAQUE_SCREEN))).toEqual(
        [],
      );
      expect(diagnosticsFor(rootRef("#/$defs/Held", { $ref: "#/$defs/Held" })))
        .toEqual([]);
    });

    it("reports a declared result that leaves its own screen opaque", async () => {
      const diagnostics = await reservedKeyDiagnostics([
        "/// <cts-enable />",
        'import { pattern, UI } from "commonfabric";',
        "type Out = { [UI]: unknown; label: string };",
        "export default pattern<{ label: string }, Out>(",
        "  (s) => ({ [UI]: s.label, label: s.label }),",
        ");",
      ]);
      expect(diagnostics.length).toBe(1);
      expect(diagnostics[0]!.severity).toBe("error");
      expect(diagnostics[0]!.message).toContain("`$UI`");
      expect(diagnostics[0]!.message).toContain("VNode");
    });

    it("names every offending key in one diagnostic", async () => {
      const diagnostics = await reservedKeyDiagnostics([
        "/// <cts-enable />",
        'import { NAME, pattern, UI } from "commonfabric";',
        "type Out = { [NAME]: unknown; [UI]: unknown; label: string };",
        "export default pattern<{ label: string }, Out>(",
        "  (s) => ({ [NAME]: s.label, [UI]: s.label, label: s.label }),",
        ");",
      ]);
      expect(diagnostics.length).toBe(1);
      expect(diagnostics[0]!.message).toContain("`$NAME`, `$UI`");
    });

    it("reports a recursive result whose root is a reference into $defs", async () => {
      const diagnostics = await reservedKeyDiagnostics([
        "/// <cts-enable />",
        'import { pattern, UI } from "commonfabric";',
        "type Branch = { [UI]: unknown; label: string; children: Branch[] };",
        "export default pattern<{ label: string }, Branch>(",
        "  (s) => ({ [UI]: s.label, label: s.label, children: [] }),",
        ");",
      ]);
      expect(diagnostics.length).toBe(1);
      expect(diagnostics[0]!.message).toContain("`$UI`");
    });

    it("accepts a result that names the type its reserved key holds", async () => {
      const diagnostics = await reservedKeyDiagnostics([
        "/// <cts-enable />",
        'import { NAME, pattern } from "commonfabric";',
        "type Out = { [NAME]: string; label: string };",
        "export default pattern<{ label: string }, Out>(",
        "  (s) => ({ [NAME]: s.label, label: s.label }),",
        ");",
      ]);
      expect(diagnostics).toEqual([]);
    });

    it("accepts an argument whose root leaves a reserved key opaque", async () => {
      const diagnostics = await reservedKeyDiagnostics([
        "/// <cts-enable />",
        'import { NAME, pattern } from "commonfabric";',
        "type StoredPiece = { [NAME]: unknown; label: string };",
        "export default pattern<StoredPiece, { label: string }>(",
        "  (s) => ({ label: s.label }),",
        ");",
      ]);
      expect(diagnostics).toEqual([]);
    });

    it("accepts a reserved key left opaque below the root of a result", async () => {
      const diagnostics = await reservedKeyDiagnostics([
        "/// <cts-enable />",
        'import { NAME, pattern } from "commonfabric";',
        "type Held = { [NAME]: unknown; label: string };",
        "type Out = { held: Held; label: string };",
        "export default pattern<{ label: string }, Out>(",
        "  (s) => ({ held: { [NAME]: s.label, label: s.label }, label: s.label }),",
        ");",
      ]);
      expect(diagnostics).toEqual([]);
    });
  });
});
