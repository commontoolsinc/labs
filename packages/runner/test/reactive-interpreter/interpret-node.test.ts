/**
 * W1b (slice) — the ROG evaluator wired into a REAL scheduler node, verified by
 * the differential oracle: a non-collection pattern run through the interpreter
 * builtin must produce the SAME result value as legacy `runtime.run`.
 *
 * This is the integration step over the pure W1a evaluator: a `raw` builtin
 * (registered like the spike's mapInterpreted) that reads the argument cell,
 * evaluates a ROG via `evalRog`, and writes the result through its output
 * binding — i.e. one node, one inline output (the footprint model).
 *
 * Scope honesty: leaf bodies are resolved here as injected impls (the W1a
 * model), not yet invoked through the SES sandbox by `$implRef`; and the ROG is
 * hand-built to mirror the target pattern rather than extracted+leaf-resolved
 * (the extract↔interpret leaf-resolution bridge is the remaining W1b wiring).
 * What this DOES verify: the evaluator integrated as a real node, materializing
 * a result that matches legacy output across leaf / access / construct /
 * control.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { raw } from "../../src/module.ts";
import { createMeasureEnv } from "../support/interpreter-measure.ts";
import {
  evalRog,
  type LeafImpl,
} from "../../src/reactive-interpreter/interpret.ts";
import type { Op, Rog } from "../../src/reactive-interpreter/rog.ts";
import type { Action } from "../../src/scheduler.ts";
import type { AddCancel } from "../../src/cancel.ts";
import type { Cell, JSONSchema } from "../../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { setResultCell } from "../../src/result-utils.ts";
import { outputSpotFromBinding } from "../../src/builtins/scope-policy.ts";

setGlobalLogFloor("error");
const signer = await Identity.fromPassphrase("ri-interpret-node");

const num = { type: "number" } as const satisfies JSONSchema;
const argSchema = {
  type: "object",
  properties: { x: num, show: { type: "boolean" } },
  required: ["x", "show"],
} as const satisfies JSONSchema;
const resultSchema = {
  type: "object",
  properties: { doubled: num, shown: num },
} as const satisfies JSONSchema;

const INTERNED_ARG = internSchema(argSchema);
const INTERNED_RESULT = internSchema(resultSchema);

// Target semantics: ({x, show}) => ({ doubled: x*2, shown: show ? x : 0 }).
// Hand-built ROG mirroring it (leaf double + control ifElse + result construct).
const T = true as unknown as Rog["resultSchema"];
function targetRog(): { rog: Rog; leafImpls: Map<number, LeafImpl> } {
  const ops: Op[] = [
    {
      id: 0,
      kind: "leaf",
      inputs: [{ kind: "argument", path: ["x"] }],
      outSchema: T,
      detail: { kind: "leaf" },
    },
    {
      id: 1,
      kind: "control",
      inputs: [],
      outSchema: T,
      detail: {
        kind: "control",
        op: "ifElse",
        pred: { kind: "argument", path: ["show"] },
        branches: [{ kind: "argument", path: ["x"] }, {
          kind: "const",
          value: 0,
        }],
      },
    },
    {
      id: 2,
      kind: "construct",
      inputs: [],
      outSchema: T,
      detail: {
        kind: "construct",
        template: {
          shape: "object",
          fields: {
            doubled: { kind: "opOut", op: 0, path: [] },
            shown: { kind: "opOut", op: 1, path: [] },
          },
        },
      },
    },
  ];
  return {
    rog: {
      argumentSchema: T,
      resultSchema: T,
      result: { kind: "opOut", op: 2, path: [] },
      ops,
    },
    leafImpls: new Map<number, LeafImpl>([[0, (v) => (v as number) * 2]]),
  };
}

/** A `raw` builtin: read the argument, evalRog, write the result inline. */
function makeRogInterpreter(rog: Rog, leafImpls: Map<number, LeafImpl>) {
  return function rogInterpreter(
    inputsCell: Cell<unknown>,
    sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
    _addCancel: AddCancel,
    _cause: unknown,
    parentCell: Cell<unknown>,
    // deno-lint-ignore no-explicit-any
    runtime: any,
    outputBinding?: NormalizedFullLink,
  ): Action {
    let result: Cell<unknown> | undefined;
    return (tx: IExtendedStorageTransaction) => {
      if (!result) {
        const outputSpot = outputSpotFromBinding(outputBinding);
        if (!outputSpot) {
          throw new Error("rogInterpreter: needs output binding");
        }
        const r = runtime.getCell(
          parentCell.space,
          { rogInterpreter: parentCell.entityId, outputSpot },
          INTERNED_RESULT,
          tx,
        ) as Cell<unknown>;
        setResultCell(r, parentCell);
        sendResult(tx, r);
        result = r;
      }
      const argument = inputsCell.asSchema(INTERNED_ARG).withTx(tx).get();
      const { result: out } = evalRog(rog, { argument, leafImpls });
      result!.withTx(tx).set(out);
    };
  };
}

describe("W1b: interpreter node output parity with legacy", () => {
  it("a non-collection pattern via the interpreter == legacy run", async () => {
    const env = createMeasureEnv(signer);
    try {
      // deno-lint-ignore no-explicit-any
      const cf = env.commonfabric as any;
      const { runtime, space } = env;

      // Legacy pattern with the same semantics.
      const double = cf.lift((x: number) => x * 2, num, num);
      const legacyPattern = cf.pattern(
        ({ x, show }: { x: number; show: boolean }) => ({
          doubled: double(x),
          shown: cf.ifElse(show, x, 0),
        }),
        argSchema,
        resultSchema,
      );

      // Interpreter builtin over the hand-built ROG.
      const { rog, leafImpls } = targetRog();
      runtime.moduleRegistry.addModuleByRef(
        "rogInterpreter",
        raw(makeRogInterpreter(rog, leafImpls)),
      );
      const rogInterpreter = cf.byRef("rogInterpreter");
      const interpreterPattern = cf.pattern(
        (arg: unknown) => rogInterpreter(arg),
        argSchema,
        resultSchema,
      );

      const cases = [{ x: 21, show: true }, { x: 7, show: false }];
      for (const arg of cases) {
        // Legacy.
        const ltx = runtime.edit();
        const lres = runtime.getCell(
          space,
          `legacy:${arg.x}:${arg.show}`,
          resultSchema,
          ltx,
        );
        const lr = runtime.run(ltx, legacyPattern, arg, lres);
        await ltx.commit();
        await runtime.idle();
        lr.sink(() => {});
        await runtime.idle();
        const legacyOut = await lr.pull() as { doubled: number; shown: number };

        // Interpreter.
        const itx = runtime.edit();
        const ires = runtime.getCell(
          space,
          `interp:${arg.x}:${arg.show}`,
          resultSchema,
          itx,
        );
        const ir = runtime.run(itx, interpreterPattern, arg, ires);
        await itx.commit();
        await runtime.idle();
        ir.sink(() => {});
        await runtime.idle();
        const interpOut = await ir.pull() as { doubled: number; shown: number };

        console.log(
          `[W1b] arg=${JSON.stringify(arg)} legacy=${
            JSON.stringify(legacyOut)
          } interp=${JSON.stringify(interpOut)}`,
        );
        // Differential oracle: identical output.
        expect(interpOut?.doubled).toBe(legacyOut?.doubled);
        expect(interpOut?.shown).toBe(legacyOut?.shown);
        // And the expected values.
        expect(interpOut?.doubled).toBe(arg.x * 2);
        expect(interpOut?.shown).toBe(arg.show ? arg.x : 0);
      }
    } finally {
      await env.dispose();
    }
  });
});
