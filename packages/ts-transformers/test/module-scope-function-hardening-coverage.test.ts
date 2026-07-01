import { assert, assertStringIncludes } from "@std/assert";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

// Module-scope function hardening freezes every top-level callable and, for
// callables a `WriteAuthorizedBy` / `TrustedActionWrite` type references,
// stamps a verified-binding identity onto them. The existing
// `module-scope-function-hardening.test.ts` covers the named function
// declaration paths. These tests target the still-uncovered shapes: an
// anonymous default-exported function declaration (rewritten to a hoisted const
// plus a default export), async modifier retention on that rewrite, and a
// trusted binding whose initializer is a direct arrow function bound to a
// non-exported name (statement-form annotation plus a separate hardening call).

async function transform(source: string): Promise<string> {
  return await transformSource(source, { types: COMMONFABRIC_TYPES });
}

Deno.test(
  "anonymous default-exported function declaration is rewritten to a hardened const and a default export",
  async () => {
    const output = await transform(
      `/// <cts-enable />\n` +
        `import { pattern } from "commonfabric";\n` +
        `export default function () { return 1; }\n`,
    );

    // The nameless default export cannot be referenced by name, so it is
    // lowered into a hoisted `const` bound to a hardened function expression and
    // re-exported by that generated name.
    assertStringIncludes(output, "const __cfDefaultFn");
    assertStringIncludes(output, "export default __cfDefaultFn");
    assertStringIncludes(output, "__cfHardenFn(function () { return 1; })");
  },
);

Deno.test(
  "anonymous default-exported async function keeps its async modifier through the rewrite",
  async () => {
    const output = await transform(
      `/// <cts-enable />\n` +
        `import { pattern } from "commonfabric";\n` +
        `export default async function () { return 1; }\n`,
    );

    // Only the `async` modifier survives on the generated function expression;
    // the export/default modifiers are dropped because the const carries the
    // export.
    assertStringIncludes(output, "const __cfDefaultFn");
    assertStringIncludes(output, "__cfHardenFn(async function () {");
    assertStringIncludes(output, "export default __cfDefaultFn");
  },
);

Deno.test(
  "trusted arrow bound to a non-exported name gets a statement-form annotation and a separate hardening call",
  async () => {
    const output = await transform(
      `/// <cts-enable />\n` +
        `import { pattern, WriteAuthorizedBy } from "commonfabric";\n` +
        `const saveTitle = (): string => "x";\n` +
        `interface Input { title: string; }\n` +
        `interface Output { savedTitle: WriteAuthorizedBy<string, typeof saveTitle>; }\n` +
        `export default pattern<Input, Output>(({ title }) => ({ savedTitle: title }));\n`,
    );

    // The binding is trusted (a WriteAuthorizedBy references it) and its
    // initializer is a direct arrow function, but the declaration is not
    // exported. The identity annotation and the hardening wrap are therefore
    // emitted as separate statements after the declaration rather than inlined
    // into the initializer.
    assert(
      !output.includes("const saveTitle = __cfBindVerifiedBinding("),
      "expected the annotation to be statement-form, not inlined",
    );
    assertStringIncludes(output, "__cfBindVerifiedBinding(saveTitle, {");
    assertStringIncludes(output, "__cfHardenFn(saveTitle)");
  },
);
