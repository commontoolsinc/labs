import { assertEquals, assertStringIncludes } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

// Foreign-output embedding check (prototype for the verb-evolution brief,
// PR #5682): a pattern whose argument or result contract embeds ANOTHER
// pattern's Output-position type gets an advisory warning pointing at the
// consumer-owned narrow type it should declare instead. Self-reference and
// `@sharedContract`-tagged protocols stay silent.

const DIAGNOSTIC_TYPE = "contract:foreign-output-embedding";

function embeddingWarnings(
  diagnostics: readonly TransformationDiagnostic[],
): readonly TransformationDiagnostic[] {
  return diagnostics.filter((d) => d.type === DIAGNOSTIC_TYPE);
}

Deno.test("Foreign-output embedding check", async (t) => {
  await t.step(
    "warns when a holder embeds another pattern's Output type",
    async () => {
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "export interface NoteOutput {",
        "  title: string;",
        "}",
        "",
        "interface NoteInput {",
        "  title?: string;",
        "}",
        "",
        "export const Note = pattern<NoteInput, NoteOutput>(({ title }) => ({",
        "  title,",
        "}));",
        "",
        "interface BoardInput {",
        "  notes?: NoteOutput[];",
        "}",
        "",
        "interface BoardOutput {",
        "  noteCount: number;",
        "}",
        "",
        "export default pattern<BoardInput, BoardOutput>(() => ({",
        "  noteCount: 0,",
        "}));",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const warnings = embeddingWarnings(diagnostics);
      assertEquals(warnings.length, 1);
      assertEquals(warnings[0]!.severity, "warning");
      assertStringIncludes(warnings[0]!.message, "NoteOutput");
      assertStringIncludes(warnings[0]!.message, "argument");
      assertStringIncludes(warnings[0]!.message, "Demand<T>");
    },
  );

  await t.step(
    "stays silent for a consumer-owned narrow type",
    async () => {
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "export interface NoteOutput {",
        "  title: string;",
        "}",
        "",
        "interface NoteInput {",
        "  title?: string;",
        "}",
        "",
        "export const Note = pattern<NoteInput, NoteOutput>(({ title }) => ({",
        "  title,",
        "}));",
        "",
        "interface NotePreview {",
        "  title?: string;",
        "}",
        "",
        "interface BoardInput {",
        "  notes?: NotePreview[];",
        "}",
        "",
        "interface BoardOutput {",
        "  noteCount: number;",
        "}",
        "",
        "export default pattern<BoardInput, BoardOutput>(() => ({",
        "  noteCount: 0,",
        "}));",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(embeddingWarnings(diagnostics).length, 0);
    },
  );

  await t.step(
    "stays silent for documented self-reference",
    async () => {
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "interface TreeInput {",
        "  label?: string;",
        "}",
        "",
        "export interface TreeOutput {",
        "  label: string;",
        "  children: TreeOutput[];",
        "}",
        "",
        "export default pattern<TreeInput, TreeOutput>(() => ({",
        '  label: "",',
        "  children: [],",
        "}));",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(embeddingWarnings(diagnostics).length, 0);
    },
  );

  await t.step(
    "stays silent for a @sharedContract-tagged protocol type",
    async () => {
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "/** @sharedContract */",
        "export interface NoteOutput {",
        "  title: string;",
        "}",
        "",
        "interface NoteInput {",
        "  title?: string;",
        "}",
        "",
        "export const Note = pattern<NoteInput, NoteOutput>(({ title }) => ({",
        "  title,",
        "}));",
        "",
        "interface BoardInput {",
        "  notes?: NoteOutput[];",
        "}",
        "",
        "interface BoardOutput {",
        "  noteCount: number;",
        "}",
        "",
        "export default pattern<BoardInput, BoardOutput>(() => ({",
        "  noteCount: 0,",
        "}));",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(embeddingWarnings(diagnostics).length, 0);
    },
  );
});
