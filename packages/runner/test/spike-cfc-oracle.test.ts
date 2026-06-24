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
 *   2. read-isolated mapInterpreted => POINTWISE. The coordinator reads only
 *      the list's link structure (identity-only, no element content) and
 *      `scheduler.subscribe`s one effect per element; each runs in its OWN tx
 *      reading ONLY its element, so its per-tx flow-join is that element's
 *      label alone. This reproduces legacy map's per-element transaction
 *      decomposition WITHOUT per-element child PATTERNS — but, like legacy, it
 *      DOES write a per-element result document (the structural fix; a single
 *      inline container cannot hold pointwise `derived` labels because a
 *      container [] write prefixes and clears every child's derived entry).
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
import {
  isPrimitiveCellLink,
  parseLink,
  toMemorySpaceAddress,
} from "../src/link-utils.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { linkResolutionProbe } from "../src/storage/reactivity-log.ts";

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
// Links-only view of the result container: slots stay cell links (never
// write-redirected into / materialized through the per-element docs), so the
// coordinator's container write is genuinely pure link structure.
const RESULT_PRESENCE_SCHEMA = internSchema({
  type: "array",
  items: { asCell: ["cell"] },
});

/**
 * Two variants of the coordinator builtin:
 *  - "batch": read the whole list in ONE transaction (the naive interpreter).
 *  - "isolated": each element is evaluated by its OWN scheduled child action
 *    (read isolation — the OQ-4 fix). The coordinator's tx reads only the list's
 *    link STRUCTURE (identity-only, like legacy map's getRaw()+resolveLink under
 *    the linkResolutionProbe scope); it never reads any element's content, so
 *    its J is empty. Each child action runs in its own scheduler transaction
 *    reading ONLY element i, so that tx's flow-join is element i's label alone
 *    => pointwise, structurally — exactly how legacy `map` gets pointwise
 *    precision (per-element transaction decomposition). Like legacy, each child
 *    writes its OWN per-element result document (path []); the container holds
 *    cell LINKS to them. A single inline container CANNOT carry pointwise
 *    `derived` labels, because a container [] write prefixes and clears every
 *    child's derived entry under it — the per-element doc is the structural fix
 *    (the 1-doc-per-element cost legacy also pays). NO per-element child
 *    PATTERN, though — the child is a plain scheduled effect.
 *  - "sibling-bug": like isolated, but element i's child also reads element
 *    i+1 — a deliberate read-isolation VIOLATION the oracle must catch (its tx
 *    join now also contains the sibling's label, so output[i] picks it up).
 *
 * Why scheduled child actions and not `runtime.edit()` sub-transactions: a node
 * cannot cleanly commit mid-run sub-transactions to a cell it created in its
 * own still-open tx (that produced mapped=undefined). `scheduler.subscribe`ing
 * each element op as an effect is the supported way to get the runtime to run
 * a labeled write in its own isolated transaction that the harness awaits via
 * `idle()`/`pull()` — the same primitive `runtime.runner.run` uses for legacy
 * per-element pattern runs.
 */
type Mode = "batch" | "isolated" | "sibling-bug";

function makeMapInterpreted(mode: Mode, leaf: (x: number) => number) {
  return function mapInterpreted(
    inputsCell: Cell<{ list: number[] }>,
    sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
    addCancel: AddCancel,
    _cause: any,
    parentCell: Cell<any>,
    runtime: Runtime,
    outputBinding?: NormalizedFullLink,
  ): Action {
    let result: Cell<number[]> | undefined;
    // Per-element child actions are subscribed exactly once (by index), like
    // legacy map's `elementRuns`.
    const elementActions = new Set<number>();

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
      const resultCell = result;

      if (mode === "batch") {
        // NAIVE: read all element values in THIS one transaction, then write
        // the whole result. All element labels join into this tx's J and smear
        // onto every output slot.
        const arr =
          (inputsCell.asSchema(MAP_INPUT_SCHEMA).key("list").withTx(tx)
            .get() as number[]) ?? [];
        const out = arr.map((v) => leaf(v));
        resultCell.withTx(tx).set(out);
        return;
      }

      // READ-ISOLATED: mirror legacy `map`'s per-element transaction
      // decomposition. Each element gets its OWN result CELL (its own doc),
      // computed by its OWN scheduled child action that reads only element i in
      // its own scheduler transaction. The container holds CELL LINKS to those
      // per-element docs — a pure-link-structure write whose J is empty (the
      // coordinator reads only the list's link STRUCTURE, never element
      // content), so the container carries only `structure` stamps, never a
      // smearing `derived` one. Each per-element doc's path-[] `derived` label =
      // element i's label alone (its child's tx read only element i), and lives
      // on a SEPARATE doc, so a container re-write never clears it. That is
      // exactly why legacy map is pointwise (and why an inline single-container
      // write is NOT — a container [] write prefixes and clears every child's
      // derived entry; the per-element doc is the structural fix, at the
      // 1-doc-per-element cost legacy also pays).
      //
      // Identity-only list materialization (copied from legacy map): read the
      // RAW slots under the `linkResolutionProbe` scope so link-following reads
      // are flow-excluded and NO element value is loaded into the coordinator's
      // tx. We build each element's slot link from the raw slot directly.
      const listCell = tx.runWithAmbientReadMeta(
        linkResolutionProbe,
        () => inputsCell.key("list").withTx(tx).resolveAsCell(),
      );
      const listBase = listCell.getAsNormalizedFullLink();
      const rawList = tx.runWithAmbientReadMeta(
        linkResolutionProbe,
        () => listCell.withTx(tx).getRaw() as unknown,
      );
      const len = Array.isArray(rawList) ? rawList.length : 0;
      const slotLink = (i: number): NormalizedFullLink => {
        const slot = (rawList as unknown[])[i];
        const link: NormalizedFullLink = isPrimitiveCellLink(slot)
          ? parseLink(slot, listBase)
          : { ...listBase, path: [...listBase.path, String(i)] };
        return tx.runWithAmbientReadMeta(
          linkResolutionProbe,
          () => resolveLink(runtime, tx, link, "value"),
        );
      };

      const resultPresence = resultCell.asSchema(RESULT_PRESENCE_SCHEMA);
      const slots = new Array<Cell<number>>(len);
      for (let i = 0; i < len; i++) {
        const index = i;
        const elemResult = runtime.getCell<number>(
          parentCell.space,
          { mapInterpretedCfcElem: resultCell.entityId, index },
          undefined,
          tx,
        );
        slots[index] = elemResult;
        if (elementActions.has(index)) continue;
        elementActions.add(index);
        const elementAction: Action = (childTx) => {
          // Read ONLY element `index` by resolving its slot link to its own
          // cell and reading that cell's value — the coordinator passed the
          // resolved slot links, so this is the one content read element i's
          // label enters J through, in this child's own isolated tx.
          const readElem = (i: number): number =>
            runtime.getCellFromLink(slotLink(i), undefined, childTx)!
              .withTx(childTx).get() as unknown as number;
          const v = readElem(index);
          let acc = v;
          if (mode === "sibling-bug" && index + 1 < len) {
            // VIOLATION: read a sibling element too. Its taint must show up in
            // output[index] — the oracle should catch this.
            const sibling = readElem(index + 1);
            acc = v + sibling * 0; // value unchanged; the READ is the leak.
          }
          elemResult.withTx(childTx).set(leaf(acc));
        };
        const reads = [slotLink(index)];
        if (mode === "sibling-bug" && index + 1 < len) {
          reads.push(slotLink(index + 1));
        }
        setResultCell(elemResult, parentCell);
        addCancel(
          runtime.scheduler.subscribe(
            elementAction,
            {
              reads: reads.map(toMemorySpaceAddress),
              shallowReads: [],
              writes: [
                toMemorySpaceAddress(elemResult.getAsNormalizedFullLink()),
              ],
            },
            // isEffect so the scheduler runs each child eagerly in its own tx
            // (the harness awaits via idle()); the labeled write to the
            // per-element doc gets a `derived` stamp from that tx's flow-join =
            // element index's label alone.
            { isEffect: true },
          ),
        );
      }
      // The container write is pure link structure (cell links to per-element
      // docs, stored as links via the presence schema); under the empty
      // coordinator J it gets only `structure` stamps — never a `derived` one.
      resultPresence.withTx(tx).set(slots as unknown as unknown[]);
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

  // RESOLVED (OQ-4, structural fix — Approach (a)). The smear above is NOT a
  // limit of the CFC machinery; it is a limit of doing the work in ONE
  // coordinator transaction. `deriveFlowJoin` is per-tx, so the fix is to make
  // each element's content read+write happen in its OWN transaction — exactly
  // what legacy `map` does via per-element result CELLS. The "isolated"
  // coordinator below reproduces that decomposition WITHOUT per-element child
  // patterns:
  //  - The coordinator reads only the list's link STRUCTURE (raw slots under
  //    the `linkResolutionProbe` scope — identity-only, like legacy map), never
  //    any element value, so ITS tx J is empty and the container gets only
  //    `structure` stamps.
  //  - Each element op is `scheduler.subscribe`d as an effect; the runtime runs
  //    it in its own isolated transaction reading ONLY element i (the resolved
  //    slot link the coordinator passed it). That tx's J = element i's label
  //    alone, stamped `derived` on element i's OWN result doc — which a
  //    container re-write cannot clear (different doc). That is genuine
  //    per-element read isolation; the pointwise labels below flow from real
  //    per-element reads, not from anything hard-coded.
  // The earlier dead-end (a node committing `runtime.edit()` sub-txs mid-run →
  // mapped=undefined) was the wrong primitive: `scheduler.subscribe` is the
  // supported way for a builtin to get the runtime to run a labeled write in
  // its own transaction (the same primitive `runtime.runner.run` uses).
  it("read-isolated coordinator keeps POINTWISE labels (the OQ-4 fix)", async () => {
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

  // The oracle's "teeth": with genuine read isolation in place, an element op
  // that illegally reads a sibling must show the sibling's taint in its output
  // (its isolated tx's J now contains the sibling's label).
  it("oracle has teeth: a sibling-reading element op is caught", async () => {
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
