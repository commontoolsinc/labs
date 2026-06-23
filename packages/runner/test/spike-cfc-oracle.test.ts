/**
 * SPIKE (throwaway): CFC differential oracle for the Reactive Interpreter — does
 * a single-coordinator `mapInterpreted` keep per-element (pointwise) CFC labels,
 * or does it SMEAR? This is the soundness-critical OQ-4 question.
 *
 * Harness + probe technique reused from cfc-flow-pointwise.test.ts:
 *   - runtime: cfcEnforcementMode "observe" + cfcFlowLabels "persist"
 *     (labels are derived & persisted without strict write-authorization).
 *   - seedLabeledNumber: a doc whose value is a number with a confidentiality
 *     atom at path [].
 *   - probe(i): read mapped[i], copy it into a fresh cell under prepareCfc, and
 *     read back the DERIVED-origin confidentiality atoms — i.e. exactly the
 *     taint a reader of mapped[i] picks up.
 *
 * KEY PRIOR FACT (cfc-flow-pointwise.test.ts:78-85): legacy `map` ALSO smears on
 * a *batch first-run* (all new element ops evaluate inline in ONE tx, so J = join
 * of every element). It only refines to POINTWISE when elements arrive in
 * SEPARATE reconciles (separate transactions reading only their element). So
 * pointwise precision == per-element transaction decomposition — nothing else.
 *
 * This spike pins:
 *   1. naive mapInterpreted (one coordinator tx, whole-list read) => SMEAR.
 *   2. read-isolated mapInterpreted (per-element sub-transaction) => POINTWISE,
 *      matching what legacy gets structurally — WITHOUT per-element child
 *      patterns or per-element documents.
 *   3. the oracle has teeth: a sibling-reading element op is caught (its label
 *      picks up the sibling's taint).
 *
 * Run:
 *   cd packages/runner
 *   deno test --allow-read --allow-write --allow-net --allow-ffi --allow-env \
 *     test/spike-cfc-oracle.test.ts
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { raw } from "../src/module.ts";
import type { Action } from "../src/scheduler.ts";
import type { AddCancel } from "../src/cancel.ts";
import type { Cell } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { setResultCell } from "../src/result-utils.ts";
import { outputSpotFromBinding } from "../src/builtins/scope-policy.ts";

const signer = await Identity.fromPassphrase("spike-cfc-oracle");
const space = signer.did();

const MAP_INPUT_SCHEMA = internSchema({
  type: "object",
  properties: { list: { type: "array", items: { type: "number" } } },
  required: ["list"],
});
const RESULT_SCHEMA = internSchema({
  type: "array",
  items: { type: "number" },
});

/**
 * Two variants of the coordinator builtin:
 *  - "batch": read the whole list in ONE transaction (the naive interpreter).
 *  - "isolated": read+write each element in its OWN sub-transaction (read
 *    isolation — the OQ-4 fix). Each sub-tx reads only element i, so its flow
 *    join is element i's label alone => pointwise, structurally.
 *  - "sibling-bug": like isolated, but element i's sub-tx also reads element
 *    i+1 — a deliberate read-isolation VIOLATION the oracle must catch.
 */
type Mode = "batch" | "isolated" | "sibling-bug";

function makeMapInterpreted(mode: Mode, leaf: (x: number) => number) {
  return function mapInterpreted(
    inputsCell: Cell<{ list: number[] }>,
    sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
    _addCancel: AddCancel,
    _cause: any,
    parentCell: Cell<any>,
    runtime: Runtime,
    outputBinding?: NormalizedFullLink,
  ): Action {
    let result: Cell<number[]> | undefined;

    return (tx: IExtendedStorageTransaction) => {
      if (!result) {
        const outputSpot = outputSpotFromBinding(outputBinding);
        if (!outputSpot) {
          throw new Error("mapInterpreted: needs output binding");
        }
        result = runtime.getCell<number[]>(
          parentCell.space,
          { mapInterpretedCfc: parentCell.entityId, outputSpot },
          RESULT_SCHEMA,
          tx,
        );
        result.send([]);
        setResultCell(result, parentCell);
        sendResult(tx, result);
      }
      const listCell = inputsCell.asSchema(MAP_INPUT_SCHEMA).key("list");
      // length: read shape only (links), no element content — keep it out of J.
      const lenProbe = listCell.withTx(tx).get() as number[] | undefined;
      const len = Array.isArray(lenProbe) ? lenProbe.length : 0;

      if (mode === "batch") {
        // NAIVE: read all element values in THIS one transaction, then write
        // the whole result. All element labels join into this tx's J and smear
        // onto every output slot.
        const arr = (listCell.withTx(tx).get() as number[]) ?? [];
        const out = arr.map((v) => leaf(v));
        result.withTx(tx).set(out);
        return;
      }

      // READ-ISOLATED: each element gets its own transaction reading only that
      // element. The main `tx` only learns the length (shape). Per-element J is
      // that element's label alone => pointwise.
      for (let i = 0; i < len; i++) {
        const sub = runtime.edit();
        const elemView = inputsCell.asSchema(MAP_INPUT_SCHEMA).withTx(sub).key(
          "list",
        );
        const v = elemView.key(String(i)).get() as unknown as number;
        let acc = v;
        if (mode === "sibling-bug" && i + 1 < len) {
          // VIOLATION: read a sibling element too. Its taint must show up in
          // output[i] — the oracle should catch this.
          const sibling = elemView.key(String(i + 1))
            .get() as unknown as number;
          acc = v + sibling * 0; // value unchanged; the READ is the leak
        }
        result.withTx(sub).key(String(i)).set(leaf(acc));
        // commit the per-element sub-transaction synchronously-ish; we await in
        // the test via runtime.idle() / pull(). Fire-and-forget here is fine for
        // the spike because the harness awaits settle before probing.
        sub.commit();
      }
    };
  };
}

describe("SPIKE CFC oracle: mapInterpreted pointwise vs smear (OQ-4)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  // Seed a doc whose value is `n` with a confidentiality atom at path [].
  const seedLabeledNumber = async (
    rt: Runtime,
    cause: string,
    n: number,
    atom?: string,
  ): Promise<Cell<number>> => {
    const seed = rt.edit();
    const cell = rt.getCell<number>(space, cause, undefined, seed);
    const id = cell.getAsNormalizedFullLink().id;
    seed.writeOrThrow({ space, scope: "space", id, path: [] }, {
      value: n,
      ...(atom
        ? {
          cfc: {
            version: 1,
            schemaHash: "seed-schema",
            labelMap: {
              version: 1,
              entries: [{ path: [], label: { confidentiality: [atom] } }],
            },
          },
        }
        : {}),
    });
    expect((await seed.commit()).ok).toBeDefined();
    return cell;
  };

  const derivedConfidentiality = (id: string): string[] => {
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: {
          labelMap?: {
            entries: Array<
              {
                path: string[];
                label: { confidentiality?: string[] };
                origin?: string;
              }
            >;
          };
        };
      } | undefined;
    };
    return (replica.getDocument(id)?.cfc?.labelMap?.entries ?? [])
      .filter((e) => e.origin === "derived")
      .flatMap((e) => e.label.confidentiality ?? []);
  };

  async function runVariant(mode: Mode, atoms: (string | undefined)[]) {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
    });
    runtime.moduleRegistry.addModuleByRef(
      "mapInterpretedCfc",
      raw(makeMapInterpreted(mode, (x: number) => x * 2)),
    );

    // Seed N labeled element docs.
    const items: Cell<number>[] = [];
    for (let i = 0; i < atoms.length; i++) {
      items.push(
        await seedLabeledNumber(runtime, `${mode}-el-${i}`, i + 1, atoms[i]),
      );
    }

    const { commonfabric } = createTrustedBuilder(runtime);
    const mapInterpreted = commonfabric.byRef("mapInterpretedCfc");
    const collectionPattern = commonfabric.pattern<{ values: number[] }>(
      ({ values }) => ({
        // deno-lint-ignore no-explicit-any
        mapped: (mapInterpreted as any)({ list: values }),
      }),
    );

    const tx = runtime.edit();
    const listCell = runtime.getCell<number[]>(
      space,
      `${mode}-list`,
      { type: "array", items: { asCell: ["cell"] } },
      tx,
    );
    listCell.set(items as unknown as number[]);
    const resultCell = runtime.getCell(space, `${mode}-result`, undefined, tx);
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: listCell },
      resultCell,
    );
    await tx.commit();
    await result.pull();
    await runtime.idle();

    // Probe each index: read mapped[i], copy under prepareCfc, read derived conf.
    const probe = async (index: number): Promise<string[]> => {
      const ptx = runtime!.edit();
      const value = (result.key("mapped") as any).key(index).withTx(ptx).get();
      const out = runtime!.getCell(
        space,
        `${mode}-probe-${index}`,
        undefined,
        ptx,
      );
      out.set({ copied: value });
      ptx.prepareCfc();
      expect((await ptx.commit()).ok).toBeDefined();
      return derivedConfidentiality(out.getAsNormalizedFullLink().id).sort();
    };

    const mapped = (result.key("mapped") as any).get() as number[];
    const confs: string[][] = [];
    for (let i = 0; i < atoms.length; i++) confs.push(await probe(i));
    return { mapped, confs };
  }

  it("naive batch coordinator SMEARS element labels across all outputs", async () => {
    // el0=alice, el1=bob, el2/el3 unlabeled.
    const { mapped, confs } = await runVariant("batch", [
      "alice-secret",
      "bob-secret",
      undefined,
      undefined,
    ]);
    console.log("\n[batch] mapped =", JSON.stringify(mapped));
    confs.forEach((c, i) =>
      console.log(`[batch] mapped[${i}] derived conf = ${JSON.stringify(c)}`)
    );
    // Smear: even the unlabeled element 2's output carries BOTH secrets.
    expect(confs[2]).toContainEqual("alice-secret");
    expect(confs[2]).toContainEqual("bob-secret");
  });

  // PENDING the read-isolation mechanism (OQ-4). Skipped, kept as the
  // executable target. FINDING (confirmed at the code level, not just here):
  //  - `deriveFlowJoin` computes ONE per-tx flow label and stamps it as the
  //    `derived` (content) component on EVERY value-write target in that tx
  //    (prepare.ts valueWriteTargets / ~:1462). So all of one batched
  //    coordinator tx's outputs get the same content label = the smear above.
  //  - Carried `cfcLabelView`s are LINK-ONLY (data-updating.ts
  //    cfcLabelViewForPrimitiveLink requires isSigilLink). An inline number
  //    value cannot carry its own per-path content label.
  //  - The naive per-element sub-transaction (runtime.edit() inside the action +
  //    fire-and-forget commit) does NOT work: the container comes back
  //    undefined (a node can't cleanly commit sub-txs to a cell it created in
  //    its own still-open tx).
  // => An INLINE-value container written by one batched node tx cannot get
  //    pointwise CONTENT labels with today's machinery. Pointwise content needs
  //    EITHER per-element transactions (legacy gets this via per-element result
  //    CELLS — the 3N cost) OR a NEW trusted per-path label-attachment mechanism
  //    (the §8.9.1 trusted-claim path, extended to emit per-path derived labels).
  //    The `structure` (membership) channel IS already per-path; only the
  //    `derived` (content) channel smears. This is exactly OQ-4, now sharpened
  //    from "enforce read isolation" to "the runtime needs a trusted per-path
  //    label-emit for batched nodes (or label-isolated sub-transactions)."
  it.skip("read-isolated coordinator keeps POINTWISE labels (the OQ-4 fix)", async () => {
    const { mapped, confs } = await runVariant("isolated", [
      "alice-secret",
      "bob-secret",
      undefined,
      undefined,
    ]);
    console.log("\n[isolated] mapped =", JSON.stringify(mapped));
    confs.forEach((c, i) =>
      console.log(`[isolated] mapped[${i}] derived conf = ${JSON.stringify(c)}`)
    );
    // Pointwise: index 0 only alice, index 1 only bob, 2/3 clean.
    expect(confs[0]).toContainEqual("alice-secret");
    expect(confs[0]).not.toContainEqual("bob-secret");
    expect(confs[1]).toContainEqual("bob-secret");
    expect(confs[1]).not.toContainEqual("alice-secret");
    expect(confs[2]).not.toContainEqual("alice-secret");
    expect(confs[2]).not.toContainEqual("bob-secret");
  });

  // Depends on the read-isolated variant (skipped above). The oracle's "teeth"
  // are the isolated-read lower-bound check: once read isolation exists, an
  // element op that reads a sibling must show the sibling's taint in its output.
  it.skip("oracle has teeth: a sibling-reading element op is caught", async () => {
    const { confs } = await runVariant("sibling-bug", [
      "alice-secret",
      "bob-secret",
      undefined,
      undefined,
    ]);
    confs.forEach((c, i) =>
      console.log(
        `[sibling-bug] mapped[${i}] derived conf = ${JSON.stringify(c)}`,
      )
    );
    // element 0's op illegally read element 1 => output[0] picks up bob-secret.
    // The oracle (this assertion) catches the read-isolation violation.
    expect(confs[0]).toContainEqual("bob-secret");
  });
});
