import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
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
      // Self-reference in the ARGUMENT contract: the tree holds pieces of
      // its own pattern. The exemption keys on the result contract's root
      // symbol, so `TreeOutput` inside `TreeInput` stays legal.
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "export interface TreeOutput {",
        "  label: string;",
        "  children: TreeOutput[];",
        "}",
        "",
        "interface TreeInput {",
        "  label?: string;",
        "  parent?: TreeOutput;",
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

  // A chain of single-property interfaces: L1.next -> L2.next -> … -> leaf.
  // From the argument root, the leaf sits at depth `links + 1`.
  const chainTo = (links: number, leaf: string): string[] => {
    const lines: string[] = [];
    for (let i = 1; i <= links; i++) {
      lines.push(
        `interface L${i} {`,
        `  next: ${i === links ? leaf : `L${i + 1}`};`,
        `}`,
        "",
      );
    }
    return lines;
  };

  const boardAround = (chain: string[]): string =>
    [
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
      ...chain,
      "interface BoardInput {",
      "  deep: L1;",
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

  await t.step(
    "still finds a foreign Output deep inside the cap",
    async () => {
      // Six links put NoteOutput at depth 7 — under the cap of 8.
      const { diagnostics } = await validateSource(
        boardAround(chainTo(6, "NoteOutput")),
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(embeddingWarnings(diagnostics).length, 1);
    },
  );

  await t.step(
    "records a debug note when the depth cap truncates the walk",
    async () => {
      const capCount = () =>
        getLoggerCountsBreakdown()["contract-lints"]?.["walk-depth-cap"]
          ?.debug ?? 0;
      const before = capCount();

      // Nine links put NoteOutput at depth 10 — past the cap, so no
      // warning fires; the truncation must be recorded, not silent.
      const { diagnostics } = await validateSource(
        boardAround(chainTo(9, "NoteOutput")),
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(embeddingWarnings(diagnostics).length, 0);
      assert(
        capCount() > before,
        "expected the walk-depth-cap debug note to be recorded",
      );
    },
  );

  await t.step(
    "does not report truncation for a deep re-encounter of an explored type",
    async () => {
      const capCount = () =>
        getLoggerCountsBreakdown()["contract-lints"]?.["walk-depth-cap"]
          ?.debug ?? 0;
      const before = capCount();

      // `Tail` is fully explored at depth 1 through `a` (finding the
      // foreign Output at depth 2), then re-encountered at depth 9 at the
      // end of the eight-link chain under `b`. Nothing reachable goes
      // unscanned, so the walk-depth note must not fire.
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
        "interface Tail {",
        "  note: NoteOutput;",
        "}",
        "",
        ...chainTo(8, "Tail"),
        "interface BoardInput {",
        "  a: Tail;",
        "  b: L1;",
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
      assertEquals(embeddingWarnings(diagnostics).length, 1);
      assertEquals(
        capCount(),
        before,
        "a re-encounter of an already-explored type is not a truncation",
      );
    },
  );
});
