/**
 * Segment CFC label granularity (spec §13 "known gap").
 *
 * A segment collapses N legacy nodes into ONE transaction, and the CFC
 * flow-join is one `deriveFlowJoin(tx)` per tx — so two INDEPENDENT
 * mixed-label outputs collapsed into a segment both get stamped with the
 * JOIN, where legacy (per-node tx) keeps them separate. This is COARSER than
 * legacy.
 *
 * The load-bearing invariant is SOUNDNESS: over-taint is fail-safe, so the
 * interpreter's per-output confidentiality must be a SUPERSET of legacy's
 * (never drop an atom = never under-taint = never leak). The coarsening
 * (both outputs carry the join) is the known precision gap — asserted here as
 * current behavior so a future per-op-label fix flips this test loudly and
 * the fix author re-pins it to legacy parity.
 */
import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("segment-cfc-labels");
const space = signer.did();

const NUM = {
  type: "object",
  properties: { n: { type: "number" } },
  required: ["n"],
} as const;

interface LabelOutcome {
  fromSecret: string[];
  fromPublic: string[];
}

async function run(interpreter: boolean): Promise<LabelOutcome> {
  const sm = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager: sm,
    cfcEnforcementMode: "observe",
    cfcFlowLabels: "persist",
    experimental: { experimentalInterpreter: interpreter },
  });
  const seed = async (cause: string, atom: string) => {
    const s = runtime.edit();
    const cell = runtime.getCell(space, cause, undefined, s);
    const id = cell.getAsNormalizedFullLink().id;
    s.writeOrThrow({ space, scope: "space", id, path: [] }, {
      value: { n: 1 },
      cfc: {
        version: 1,
        schemaHash: "seed",
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: [atom] } }],
        },
      },
    });
    await s.commit();
    return runtime.getCell(space, cause);
  };
  const secretCell = await seed("seg-lbl-secret", "SECRET");
  const publicCell = await seed("seg-lbl-public", "PUBLIC");

  // deno-lint-ignore no-explicit-any
  const cf = createTrustedBuilder(runtime).commonfabric as any;
  const { pattern, lift } = cf;
  // Two INDEPENDENT lifts — flag-off = two nodes/txs; flag-on = one segment.
  const Root = pattern((input: any) => ({
    fromSecret: lift((v: { n: number }) => v.n * 10, NUM, { type: "number" })(
      input.s,
    ),
    fromPublic: lift((v: { n: number }) => v.n * 100, NUM, { type: "number" })(
      input.p,
    ),
  }));

  const tx = runtime.edit();
  const rc = runtime.getCell(
    space,
    `seg-lbl-res-${interpreter}`,
    undefined,
    tx,
  );
  const result = runtime.run(tx, Root, { s: secretCell, p: publicCell }, rc);
  runtime.prepareTxForCommit(tx);
  await tx.commit();
  await runtime.idle();
  await sm.synced();
  await result.pull();

  const replica = sm.open(space).replica as unknown as {
    getDocument(id: string): {
      cfc?: {
        labelMap?: {
          entries: Array<{ label: { confidentiality?: string[] } }>;
        };
      };
    } | undefined;
  };
  const confOfDoc = (id: string) =>
    [
      ...new Set(
        (replica.getDocument(id)?.cfc?.labelMap?.entries ?? [])
          .flatMap((e) => e.label.confidentiality ?? []),
      ),
    ].sort();
  // deno-lint-ignore no-explicit-any
  const rootRaw = result.getRaw?.({ lastNode: "writeRedirect" }) as any;
  const targetId = (field: string): string =>
    rootRaw?.[field]?.["/"]?.["link@1"]?.id ?? "";
  const out = {
    fromSecret: confOfDoc(targetId("fromSecret")),
    fromPublic: confOfDoc(targetId("fromPublic")),
  };
  await runtime.dispose();
  await sm.close();
  return out;
}

describe("segment CFC label granularity (§13 known gap)", () => {
  it("legacy is per-node precise; the segment coarsens to the join (fail-safe superset)", async () => {
    const off = await run(false);
    const on = await run(true);

    console.log(
      `[seg-lbl] OFF=${JSON.stringify(off)} ON=${JSON.stringify(on)}`,
    );

    // Legacy oracle: per-node txs keep independent outputs SEPARATE.
    assertEquals(off.fromSecret, ["SECRET"]);
    assertEquals(off.fromPublic, ["PUBLIC"]);

    // SOUNDNESS INVARIANT (must always hold): the interpreter never DROPS an
    // atom legacy carried — over-taint is safe, under-taint would leak.
    const superset = (a: string[], b: string[]) =>
      b.every((x) => a.includes(x));
    assert(
      superset(on.fromSecret, off.fromSecret),
      `fromSecret must not under-taint: ON ${JSON.stringify(on.fromSecret)} ⊇ ${
        JSON.stringify(off.fromSecret)
      }`,
    );
    assert(
      superset(on.fromPublic, off.fromPublic),
      `fromPublic must not under-taint: ON ${JSON.stringify(on.fromPublic)} ⊇ ${
        JSON.stringify(off.fromPublic)
      }`,
    );

    // CURRENT-STATE (the known coarsening gap): the segment stamps BOTH
    // outputs with the tx join. When per-op label attribution lands, this
    // flips to legacy parity — update these two lines then (the superset
    // asserts above stay).
    assertEquals(on.fromSecret, ["PUBLIC", "SECRET"]);
    assertEquals(on.fromPublic, ["PUBLIC", "SECRET"]);
  });
});
