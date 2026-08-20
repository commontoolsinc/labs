/**
 * The module verifier admits a trusted builder's callback in two spellings —
 * written at the call, or a plain identifier bound to a function in the same
 * module — and refuses to load a module that uses any other
 * (`verifyTrustedBuilderCall`, spec §17.6). This stage refuses the same
 * spellings at compile time, so the author is pointed at the argument instead
 * of meeting a verifier message at load.
 *
 * These sources compile against the REAL commonfabric surface
 * (`COMMONFABRIC_TYPES` loads `types/commonfabric.d.ts`), so what the checker
 * says about callback-ness here is what it says about a real pattern.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { validateFiles, validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

function indirectCallbackErrors(
  diagnostics: readonly TransformationDiagnostic[],
) {
  return diagnostics.filter(
    (d) =>
      d.type === "builder-callback:indirect-reference" &&
      d.severity === "error",
  );
}

async function errorsIn(moduleBody: string) {
  const source = `
    import { Cell, handler, lift, pattern } from "commonfabric";
    ${moduleBody}
    export default pattern(() => ({}));
  `;
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  return indirectCallbackErrors(diagnostics);
}

Deno.test("a callback reached through a property access errors", async () => {
  const errors = await errorsIn(`
    const callbacks = {
      save(_event: unknown, _state: { count: Cell<number> }) {},
    };
    const saveVerb = handler<unknown, { count: Cell<number> }>(callbacks.save);
  `);
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0].message, "through a property access");
  assertStringIncludes(errors[0].message, "refused");
});

Deno.test("a callback imported from another module errors", async () => {
  const { diagnostics } = await validateFiles({
    "/helpers.ts": `
      export const save = (_event: unknown, _state: { count: number }) => {};
    `,
    "/test.tsx": `
      import { handler, pattern } from "commonfabric";
      import { save } from "./helpers.ts";
      const saveVerb = handler(save);
      export default pattern(() => ({}));
    `,
  }, { types: COMMONFABRIC_TYPES });
  const errors = indirectCallbackErrors(diagnostics);
  assertEquals(errors.length, 1);
  assertStringIncludes(
    errors[0].message,
    "a binding this module does not declare",
  );
});

Deno.test("a callback written at the call is accepted", async () => {
  assertEquals(
    (await errorsIn(`
      const inc = lift((n: number) => n + 1);
    `)).length,
    0,
  );
});

Deno.test("a same-module const bound to a function is accepted", async () => {
  assertEquals(
    (await errorsIn(`
      const bump = (n: number) => n + 1;
      const inc = lift(bump);
    `)).length,
    0,
  );
});

Deno.test("a same-module function declaration is accepted", async () => {
  // Declarations hoist, so the declaration may follow its use.
  assertEquals(
    (await errorsIn(`
      const inc = lift(bump);
      function bump(n: number) {
        return n + 1;
      }
    `)).length,
    0,
  );
});

Deno.test("an alias of a same-module function is accepted", async () => {
  // The verifier propagates the function classification through the alias, so
  // rejecting this would refuse a module it loads.
  assertEquals(
    (await errorsIn(`
      function bump(n: number) {
        return n + 1;
      }
      const alias = bump;
      const inc = lift(alias);
    `)).length,
    0,
  );
});

Deno.test("an argument that is not function-bearing is left alone", async () => {
  // The verifier rejects this too, but as a different mistake — and whatever
  // already describes it does so more accurately than a callback diagnostic.
  assertEquals(
    (await errorsIn(`
      const inc = lift({ type: "object" } as never);
    `)).length,
    0,
  );
});
