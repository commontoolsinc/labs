// Server-execution v2 Phase 2 gate: client speculation, live
// (testing.md §5's `sx2-speculation` — echo latency, overlay
// retirement, and the client's lost derivation-commit path). A
// PiecesController client drives the counter pattern against toolshed:
//
// - the ECHO: the actor's own edit renders locally without waiting on
//   the server round trip (speculation.md §3 — rendering reads through
//   the overlay);
// - RETIREMENT: once the replicated watermark covers the input, the
//   overlay empties (speculation.md §4) and the STORE value renders
//   through the same path;
// - the client commits NO derivation: the overlay diagnostic is the
//   client-side witness here; the store-attribution query (zero
//   `derived`-class commits from any client session) is pinned with
//   engine access in `packages/runner/test/speculation-overlay.test.ts`
//   and the admission layer refuses non-holder derived commits by
//   construction (protocol.md §2).
//
// OFF arm: the client derives and commits as today — the overlay never
// exists (byte-identical posture), asserted explicitly.

import { env } from "@commonfabric/integration";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { waitForSettled } from "@commonfabric/runner/executor/watermark";
import type { MemorySpace } from "@commonfabric/runner";
import {
  initializePiecesController,
  type PieceController,
  type PiecesController,
} from "./pieces-controller.ts";

const { API_URL, SPACE_NAME } = env;

const FLAG_ON = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION") === "true";

describe("sx2 speculation (Phase 2 gates)", () => {
  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;
  let sinkCancel: (() => void) | undefined;
  let latestValue: number | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      spaceName: `${SPACE_NAME}-sx2-spec`,
      apiUrl: new URL(API_URL),
      identity,
    });
    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "counter",
      "counter.tsx",
    );
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath),
    );
    piece = await cc.create(program, { start: true });
    const resultCell = cc.manager().getResult(piece.getCell());
    sinkCancel = resultCell.sink((value) => {
      latestValue = (value as { value?: number } | undefined)?.value;
    });
  });

  afterAll(async () => {
    sinkCancel?.();
    if (cc) await cc.dispose();
  });

  it("echoes locally, retires the overlay on watermark coverage, and never holds a derivation commit (speculation.md §1, §3, §4)", async () => {
    const runtime = cc.manager().runtime;
    if (!FLAG_ON) {
      // OFF arm, byte-identical: no overlay exists — the client derives
      // and commits as today.
      assertEquals(runtime.speculationOverlay, undefined);
      await piece.result.set(7, ["value"]);
      await runtime.storageManager.synced();
      assertEquals(await piece.result.get(["value"]), 7);
      return;
    }

    const space = piece.getCell().getAsNormalizedFullLink()
      .space as MemorySpace;

    // The ECHO: the authored edit's local render does not gate on the
    // serving round trip. The result sink observes the value through
    // the overlay-reading path as soon as the local run lands.
    const echoStart = performance.now();
    await piece.result.set(7, ["value"]);
    const deadline = performance.now() + 5_000;
    while (latestValue !== 7 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const echoMs = performance.now() - echoStart;
    assertEquals(latestValue, 7);

    // RETIREMENT: settle via the watermark, then the overlay must
    // drain — the authoritative values replaced every echo entry
    // (speculation.md §4; the diagnostic is the client-side witness of
    // "commits nothing for derivations").
    await runtime.storageManager.synced();
    await waitForSettled(runtime, space, 1, { timeoutMs: 30_000 });
    const overlay = runtime.speculationOverlay;
    const drainDeadline = Date.now() + 20_000;
    while (
      overlay !== undefined && overlay.entryCount(space) > 0 &&
      Date.now() < drainDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assertEquals(
      overlay === undefined ? 0 : overlay.entryCount(space),
      0,
      "every overlay entry must retire once the watermark covers its " +
        "basis (speculation.md §4)",
    );

    // The value stands — now as STORE state through the same render
    // path (silent replacement, speculation.md §3).
    assertEquals(await piece.result.get(["value"]), 7);

    // Echo latency is recorded, not gated: the actor-side parity
    // measurement follows testing.md §1's protocol (adjacent arms,
    // quiet box) — this in-suite number is context only.
    console.log(`[sx2-speculation] echo observed after ${echoMs.toFixed(0)}ms`);
  });
});
