/**
 * W1b-bridge — the extract↔interpret seam, end-to-end with REAL extraction.
 *
 * This closes the gap that interpret-node.test.ts deliberately sidesteps: there
 * the ROG is HAND-BUILT to mirror the target pattern. Here the ROG comes
 * straight out of `extractRog` over a pattern built by the real builder, the
 * leaf implementations are resolved from the in-memory module bodies
 * (`resolveLeafImpls`), `internalToOp` is the wiring `extractRog` now exposes,
 * and the evaluated result is checked for parity against legacy `runtime.run`.
 *
 * Leaf resolution boundary: for an in-memory built pattern the builder keeps the
 * lift body as a live callable at `module.implementation`, so leaves resolve
 * directly — no SES sandbox needed. A *serialized* pattern would only carry the
 * `$implRef` (source-string form), which requires the session implementation
 * index to invoke; that is the W1b-sandbox boundary and is out of scope here.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import { createMeasureEnv } from "../support/interpreter-measure.ts";
import {
  extractRog,
  resolveLeafImpls,
} from "../../src/reactive-interpreter/extract.ts";
import { evalRog } from "../../src/reactive-interpreter/interpret.ts";
import type { JSONSchema } from "../../src/builder/types.ts";

setGlobalLogFloor("error");
const signer = await Identity.fromPassphrase("ri-extract-interpret");
const num = { type: "number" } as const satisfies JSONSchema;

/** Run a built pattern through legacy `runtime.run` and read its result. */
// deno-lint-ignore no-explicit-any
async function legacyRun(
  env: ReturnType<typeof createMeasureEnv>,
  pattern: any,
  arg: unknown,
  resultSchema: JSONSchema,
  cause: string,
): Promise<unknown> {
  const { runtime, space } = env;
  const tx = runtime.edit();
  const res = runtime.getCell(space, cause, resultSchema, tx);
  const r = runtime.run(tx, pattern, arg, res);
  await tx.commit();
  await runtime.idle();
  r.sink(() => {});
  await runtime.idle();
  return await r.pull();
}

describe("W1b-bridge: extracted ROG (not hand-built) == legacy run", () => {
  it("({x,show}) => ({doubled: double(x), shown: ifElse(show,x,0)})", async () => {
    const env = createMeasureEnv(signer);
    try {
      // deno-lint-ignore no-explicit-any
      const cf = env.commonfabric as any;
      const argSchema = {
        type: "object",
        properties: { x: num, show: { type: "boolean" } },
        required: ["x", "show"],
      } as const satisfies JSONSchema;
      const resultSchema = {
        type: "object",
        properties: { doubled: num, shown: num },
      } as const satisfies JSONSchema;

      const double = cf.lift((x: number) => x * 2, num, num);
      const pattern = cf.pattern(
        ({ x, show }: { x: number; show: boolean }) => ({
          doubled: double(x),
          shown: cf.ifElse(show, x, 0),
        }),
        argSchema,
        resultSchema,
      );

      // REAL extraction — NOT hand-built.
      const ex = extractRog(pattern);
      const { leafImpls, unresolvedLeafOps } = resolveLeafImpls(
        pattern,
        ex.rog,
      );
      // The in-memory module bodies must all resolve; if this regresses we want
      // to see it loudly rather than silently evaluate with a missing leaf.
      expect(unresolvedLeafOps).toEqual([]);
      // Sanity: the result fields wire through `internal` refs, so the wiring
      // map must be populated (this is what closes the W1a `internal` gap).
      expect(ex.internalToOp.size).toBeGreaterThanOrEqual(2);

      const cases = [{ x: 21, show: true }, { x: 7, show: false }];
      for (const arg of cases) {
        const legacyOut = await legacyRun(
          env,
          pattern,
          arg,
          resultSchema,
          `legacy:${arg.x}:${arg.show}`,
        ) as { doubled: number; shown: number };

        const { result } = evalRog(ex.rog, {
          argument: arg,
          leafImpls,
          internalToOp: ex.internalToOp,
        });
        const interpOut = result as { doubled: number; shown: number };

        console.log(
          `[W1b-bridge] arg=${JSON.stringify(arg)} legacy=${
            JSON.stringify(legacyOut)
          } interp=${JSON.stringify(interpOut)}`,
        );

        // Differential oracle: extracted-ROG eval == legacy run.
        expect(interpOut.doubled).toBe(legacyOut.doubled);
        expect(interpOut.shown).toBe(legacyOut.shown);
        // And the expected ground truth.
        expect(interpOut.doubled).toBe(arg.x * 2);
        expect(interpOut.shown).toBe(arg.show ? arg.x : 0);
      }
    } finally {
      await env.dispose();
    }
  });

  it("nested access: ({user}) => ({next: inc(user.age)})", async () => {
    const env = createMeasureEnv(signer);
    try {
      // deno-lint-ignore no-explicit-any
      const cf = env.commonfabric as any;
      const argSchema = {
        type: "object",
        properties: {
          user: { type: "object", properties: { age: num } },
        },
        required: ["user"],
      } as const satisfies JSONSchema;
      const resultSchema = {
        type: "object",
        properties: { next: num },
      } as const satisfies JSONSchema;

      const inc = cf.lift((x: number) => x + 1, num, num);
      const pattern = cf.pattern(
        ({ user }: { user: { age: number } }) => ({ next: inc(user.age) }),
        argSchema,
        resultSchema,
      );

      const ex = extractRog(pattern);
      const { leafImpls, unresolvedLeafOps } = resolveLeafImpls(
        pattern,
        ex.rog,
      );
      expect(unresolvedLeafOps).toEqual([]);
      // The leaf reads a NESTED argument path (user.age) — verify extraction
      // captured the structured access faithfully rather than flattening it.
      const leaf = ex.rog.ops.find((op) => op.detail.kind === "leaf");
      expect(leaf).toBeDefined();
      expect(leaf!.inputs).toEqual([{
        kind: "argument",
        path: ["user", "age"],
      }]);

      for (const arg of [{ user: { age: 40 } }, { user: { age: 0 } }]) {
        const legacyOut = await legacyRun(
          env,
          pattern,
          arg,
          resultSchema,
          `legacy-nested:${arg.user.age}`,
        ) as { next: number };

        const { result } = evalRog(ex.rog, {
          argument: arg,
          leafImpls,
          internalToOp: ex.internalToOp,
        });
        const interpOut = result as { next: number };

        console.log(
          `[W1b-bridge nested] arg=${JSON.stringify(arg)} legacy=${
            JSON.stringify(legacyOut)
          } interp=${JSON.stringify(interpOut)}`,
        );

        expect(interpOut.next).toBe(legacyOut.next);
        expect(interpOut.next).toBe(arg.user.age + 1);
      }
    } finally {
      await env.dispose();
    }
  });
});
