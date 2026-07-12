// PROPOSED HOME: append to
// packages/ts-transformers/test/module-scope-function-hardening-coverage.test.ts
// (same imports/helpers; shown standalone here for review).
//
// Pins two load-bearing emission facts the behavior spec (§17.3) currently
// carries as "verified by direct pipeline run" only:
//
// 1. STATEMENT ORDER — annotation before hardening. The emitted
//    `__cfBindVerifiedBinding` helper stamps identity only on
//    `Object.isExtensible` values; `__cfHardenFn` freezes. If the emission
//    order ever flipped, the identity would be silently dropped at load and
//    every WriteAuthorizedBy commit-check would start failing with
//    "writeAuthorizedBy requires a trusted verified binding identity".
//    The existing coverage test asserts both statements EXIST but not their
//    relative order; the existing hardening test asserts the annotation only.
//
// 2. EXPORTED-INLINE NESTING — hardener outermost:
//    `export const writeFn = __cfHardenFn(__cfBindVerifiedBinding(fn, {…}));`.
//    The reverse nesting would also pass the verifier's expression grammar
//    (each helper classifies as its argument) but freeze before stamping —
//    the same silent identity drop. cfc-authoring.test.ts pins only the
//    builder-call inline case, where no hardener is emitted.

import { assert } from "@std/assert";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

async function transform(source: string): Promise<string> {
  return await transformSource(source, { types: COMMONFABRIC_TYPES });
}

Deno.test(
  "trusted named function declaration emits annotation-then-hardening, in that order",
  async () => {
    const output = await transform(
      `/// <cts-enable />\n` +
        `import { pattern, WriteAuthorizedBy } from "commonfabric";\n` +
        `function saveTitle(): string { return "x"; }\n` +
        `interface Input { title: string; }\n` +
        `interface Output { savedTitle: WriteAuthorizedBy<string, typeof saveTitle>; }\n` +
        `export default pattern<Input, Output>(({ title }) => ({ savedTitle: title }));\n`,
    );

    const declIdx = output.indexOf("function saveTitle()");
    const annotationIdx = output.indexOf(
      "__cfBindVerifiedBinding(saveTitle, {",
    );
    const hardenIdx = output.indexOf("__cfHardenFn(saveTitle);");
    assert(declIdx >= 0, "expected the function declaration to survive");
    assert(annotationIdx >= 0, "expected a statement-form annotation");
    assert(hardenIdx >= 0, "expected a statement-form hardening call");
    // The order is load-bearing: the binding helper only stamps extensible
    // values, and hardening freezes the function.
    assert(
      declIdx < annotationIdx && annotationIdx < hardenIdx,
      `expected declaration < annotation < hardening, got ${declIdx}/${annotationIdx}/${hardenIdx}`,
    );
  },
);

Deno.test(
  "trusted non-exported arrow keeps annotation before its separate hardening call",
  async () => {
    const output = await transform(
      `/// <cts-enable />\n` +
        `import { pattern, WriteAuthorizedBy } from "commonfabric";\n` +
        `const saveTitle = (): string => "x";\n` +
        `interface Input { title: string; }\n` +
        `interface Output { savedTitle: WriteAuthorizedBy<string, typeof saveTitle>; }\n` +
        `export default pattern<Input, Output>(({ title }) => ({ savedTitle: title }));\n`,
    );

    const annotationIdx = output.indexOf(
      "__cfBindVerifiedBinding(saveTitle, {",
    );
    const hardenIdx = output.indexOf("__cfHardenFn(saveTitle);");
    assert(annotationIdx >= 0 && hardenIdx >= 0, "expected both statements");
    assert(
      annotationIdx < hardenIdx,
      `expected annotation before hardening, got ${annotationIdx}/${hardenIdx}`,
    );
  },
);

Deno.test(
  "exported trusted direct function nests the hardener outermost, inline",
  async () => {
    const output = await transform(
      `/// <cts-enable />\n` +
        `import { pattern, WriteAuthorizedBy } from "commonfabric";\n` +
        `export const writeFn = (value: string): string => value;\n` +
        `interface Input { title: string; }\n` +
        `interface Output { savedTitle: WriteAuthorizedBy<string, typeof writeFn>; }\n` +
        `export default pattern<Input, Output>(({ title }) => ({ savedTitle: title }));\n`,
    );

    assert(
      output.includes(
        "export const writeFn = __cfHardenFn(__cfBindVerifiedBinding(",
      ),
      "expected inline annotation with the hardener nested outermost",
    );
    assert(
      !output.includes("__cfBindVerifiedBinding(writeFn, {"),
      "expected no statement-form annotation for the exported binding",
    );
    assert(
      !output.includes("__cfBindVerifiedBinding(__cfHardenFn("),
      "reverse nesting would freeze before stamping and silently drop the identity",
    );
  },
);
