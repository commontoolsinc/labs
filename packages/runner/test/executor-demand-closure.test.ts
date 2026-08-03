/**
 * D2 (client-passivity §5h.4, owner ruling: "Of course we need to run child
 * sub-patterns, otherwise nothing runs them. Punting to the client is _not an
 * option_"): a lane's demand slice names ROOTS only, so a child sub-pattern
 * piece has to be recognised as inside a demanded root's CLOSURE or it can
 * never be a scoped-rank candidate.
 *
 * The measured symptom this pins the fix for: in the flagship group-chat rank
 * probe, `openUserLaneKeys` returned `[]` for 20 distinct child piece ids
 * across 134 lane-miss events, every lane carrying exactly one
 * schedulerPiece (the probe's demand root) with EMPTY overlap. Space-rank
 * candidacy has no such filter and the host has none, so
 * `cf:builtin/map:v1` — living in a nested sub-pattern — could hold a space
 * claim and never a user or session one.
 *
 * Two legs, deliberately at different levels:
 *   1. the walk itself (`laneSliceCoversPiece`), including the cycle and depth
 *      guards, which no integration fixture can exercise;
 *   2. the ancestry the runner actually records for a real nested pattern,
 *      keyed `${scope}:${id}` — the same alphabet as an
 *      `ActionClaimKey.pieceId` and a lane's
 *      `canonicalSchedulerPieceIdForDemandRoot` slice, because a chain in the
 *      wrong alphabet would match nothing while looking correct.
 */
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { canonicalSchedulerPieceIdForDemandRoot } from "@commonfabric/memory/v2";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import {
  demandClosureChain,
  laneSliceCoversPiece,
  MAX_DEMAND_CLOSURE_DEPTH,
} from "../src/executor/demand-closure.ts";

const signer = await Identity.fromPassphrase("executor demand closure probe");
const space = signer.did();

Deno.test("demand closure: a lane slice covers a child piece through its ancestors", () => {
  const parents = new Map<string, string>([
    ["space:of:child", "space:of:middle"],
    ["space:of:middle", "space:of:root"],
  ]);
  const parentOf = (pieceId: string) => parents.get(pieceId);
  const slice = new Set(["space:of:root"]);

  // The whole point: a grandchild of the demanded root is covered.
  assert(laneSliceCoversPiece(slice, "space:of:child", parentOf));
  assert(laneSliceCoversPiece(slice, "space:of:middle", parentOf));
  // A root is covered directly, without consulting ancestry at all.
  assert(
    laneSliceCoversPiece(new Set(["space:of:root"]), "space:of:root", () => {
      throw new Error("the direct hit must not walk");
    }),
  );
  // Widening candidacy is NOT widening it to everything: an unrelated piece
  // whose chain never reaches this lane's roots stays uncovered.
  assertEquals(
    laneSliceCoversPiece(slice, "space:of:unrelated", parentOf),
    false,
  );
  assertEquals(
    demandClosureChain("space:of:child", parentOf),
    ["space:of:child", "space:of:middle", "space:of:root"],
  );
});

Deno.test("demand closure: the walk terminates on a cycle and on depth", () => {
  const cyclic = new Map<string, string>([
    ["a", "b"],
    ["b", "a"],
  ]);
  assertEquals(
    laneSliceCoversPiece(new Set(["z"]), "a", (id) => cyclic.get(id)),
    false,
  );
  assertEquals(demandClosureChain("a", (id) => cyclic.get(id)), ["a", "b"]);

  // An unbounded chain stops at the depth guard rather than spinning.
  const infinite = (id: string) => `${id}+`;
  assertEquals(
    demandClosureChain("a", infinite).length,
    MAX_DEMAND_CLOSURE_DEPTH + 1,
  );
  assertEquals(laneSliceCoversPiece(new Set(["z"]), "a", infinite), false);
});

Deno.test("demand closure: the runner records a nested sub-pattern's parent piece", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { serverPrimaryExecution: true },
  });
  try {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern } = commonfabric;

    // Two levels of nesting, so the test distinguishes "records the immediate
    // parent" from "records the root" — a one-level fixture cannot.
    const Leaf = pattern(() => ({ leaf: "leaf" }));
    const Middle = pattern(() => ({ child: Leaf({}) }));
    const Root = pattern(() => ({ child: Middle({}) }));

    const tx = runtime.edit();
    const rootCell = runtime.getCell<{ child: unknown }>(
      space,
      "executor demand closure root",
      undefined,
      tx,
    );
    const handle = runtime.run(tx, Root, {}, rootCell);
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    assertEquals(await runtime.start(rootCell), true);
    await runtime.settled();

    // Demand names the ROOT only, keyed the way a lane's slice is keyed.
    const rootLink = rootCell.getAsNormalizedFullLink();
    const rootPieceId = canonicalSchedulerPieceIdForDemandRoot(rootLink.id);
    const slice = new Set([rootPieceId]);
    const parentOf = (pieceId: string) =>
      runtime.runner.parentPieceIdOf(pieceId);

    // Every started piece except the root is a child; each one must roll up.
    // Read off the public cancels map (`${space}/${scope}/${uri}`) so the test
    // never hardcodes a minted entity id.
    const startedPieceIds = [...runtime.runner.cancels.keys()].map((key) => {
      const rest = key.slice(key.indexOf("/") + 1);
      return rest.replace("/", ":");
    });
    assert(
      startedPieceIds.length >= 3,
      `expected root + two nested pieces, got ${
        JSON.stringify(startedPieceIds)
      }`,
    );
    assert(
      startedPieceIds.includes(rootPieceId),
      `instrument blind: the root piece ${rootPieceId} is not among the ` +
        `started pieces ${JSON.stringify(startedPieceIds)}`,
    );

    const uncovered = startedPieceIds.filter(
      (pieceId) => !laneSliceCoversPiece(slice, pieceId, parentOf),
    );
    assertEquals(
      uncovered,
      [],
      "a started child sub-pattern piece is outside the demanded root's " +
        "closure, so scoped-rank candidacy can never see its actions",
    );

    // The chain is the real nesting depth, not a flattened root pointer: the
    // leaf reaches the root through the middle piece.
    const leafPieceId = startedPieceIds.find((pieceId) =>
      demandClosureChain(pieceId, parentOf).length === 3
    );
    assert(
      leafPieceId !== undefined,
      `no piece has a two-ancestor chain; chains were ${
        JSON.stringify(
          startedPieceIds.map((pieceId) =>
            demandClosureChain(pieceId, parentOf)
          ),
        )
      }`,
    );
    assertEquals(
      demandClosureChain(leafPieceId!, parentOf).at(-1),
      rootPieceId,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
