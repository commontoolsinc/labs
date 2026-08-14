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
    "warns when a foreign Output is the input-position type argument",
    async () => {
      // Using another pattern's Output as your own INPUT is the embedding
      // at its largest — the whole contract as the argument — and must not
      // ride the self-reference exemption, which covers only the pattern's
      // own output position.
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
        "interface WrapperOutput {",
        "  wrapped: number;",
        "}",
        "",
        "export default pattern<NoteOutput, WrapperOutput>(({ title }) => ({",
        "  wrapped: title.length,",
        "}));",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const warnings = embeddingWarnings(diagnostics);
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0]!.message, "NoteOutput");
      assertStringIncludes(warnings[0]!.message, "argument");
    },
  );

  await t.step(
    "warns when a foreign Output is the single-generic input",
    async () => {
      // `pattern<T>`'s one argument is the INPUT (the result is inferred),
      // so a foreign Output there is the whole-contract embed and must not
      // ride any self-reference exemption.
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
        "export default pattern<NoteOutput>(({ title }) => ({",
        "  label: title,",
        "}));",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const warnings = embeddingWarnings(diagnostics);
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0]!.message, "NoteOutput");
      assertStringIncludes(warnings[0]!.message, "argument");
    },
  );

  await t.step(
    "never indexes a single-generic pattern's input as an Output",
    async () => {
      // The provider below only ever declares its INPUT explicitly; its
      // result is inferred. A consumer embedding that input type is not
      // embedding anyone's output contract.
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "export interface NoteState {",
        "  title?: string;",
        "}",
        "",
        "export const Note = pattern<NoteState>(({ title }) => ({",
        "  title,",
        "}));",
        "",
        "interface BoardInput {",
        "  notes?: NoteState[];",
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
    "stays silent for inline-literal type arguments",
    async () => {
      // An anonymous output shape has no name to hold anyone to, so it is
      // never indexed — and a holder embedding a plain literal is its own.
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "export const Note = pattern<{ title?: string }, { title: string }>(",
        "  ({ title }) => ({ title }),",
        ");",
        "",
        "interface BoardInput {",
        "  notes?: { title?: string }[];",
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
