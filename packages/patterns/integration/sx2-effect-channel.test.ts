// Server-execution v2 Phase 4 gate: the client-effect channel, live
// (testing.md §5's `sx2-effect-channel`). A PiecesController client
// drives the sx2-navigate fixture's `go` stream against toolshed:
//
// - the SERVED navigateTo (builtins.md §4's split contract): the fire
//   commits ONLY the event; the SpaceServer computes the target and
//   writes the §5 intent into the FIRING session's effects instance,
//   which the client reads back through its OWN subscription (the
//   instance resolves from the authenticated session — the client
//   names no key, T2.Q3);
// - OPTIMISTIC-ENACT RECONCILE (T2.Q7): the flag-ON client's
//   speculative run enacts the navigation immediately, carrying the
//   same deterministic nonce — the authoritative intent CONVERGES on
//   it and the journey ends with exactly ONE navigation;
// - ACK + RETIREMENT (protocol.md §5): the channel acks by nonce (an
//   ordinary authored write of the session's own `acks[nonce]` mark)
//   and the next wave retires the acked entry — the instance drains,
//   and nothing resurrects.
//
// OFF arm: navigateTo runs client-side exactly as today — the
// navigation enacts locally and NO effects doc exists anywhere.
//
// The RELOAD-between-intent-and-ack journey (LT8) lives in the runner
// suite (`executor-effect-channel.test.ts`), where the runtime can be
// torn down over a persisted session; this surface cannot reload its
// controller (a fresh controller is a fresh session until protocol
// §5's client-side session persistence lands — OW20's trigger).

import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import { env } from "@commonfabric/integration";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { waitForSettled } from "@commonfabric/runner/executor/watermark";
import type { MemorySpace } from "@commonfabric/runner";
import {
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  type SessionEffectsDocValue,
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import {
  initializePiecesController,
  type PieceController,
  type PiecesController,
} from "./pieces-controller.ts";

const { API_URL, SPACE_NAME } = env;

// The arm this process runs in: the explicit env value, else the
// first-party default (ON since the server-execution v2 Phase 7 flip —
// the deployed-topology presets resolve an unset flag to it, and so does
// the toolshed the harness started).
const FLAG_ON = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION") === undefined
  ? SERVER_EXECUTION_DEFAULT_ENABLED
  : Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION") === "true";

type EffectStats = { effectAcks: number };

const fetchStats = async (): Promise<EffectStats | undefined> => {
  const response = await fetch(new URL("/api/health/stats", API_URL));
  const body = await response.json() as { servingLoop?: EffectStats };
  return body.servingLoop;
};

const waitUntil = async (
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("sx2 effect channel (Phase 4 gates)", () => {
  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;
  const navigations: string[] = [];

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      spaceName: `${SPACE_NAME}-sx2-effects`,
      apiUrl: new URL(API_URL),
      identity,
      navigateCallback: (target) => {
        navigations.push(target.getAsNormalizedFullLink().id);
      },
    });
    const sourcePath = join(
      import.meta.dirname!,
      "fixtures",
      "sx2-navigate.tsx",
    );
    const program = await cc.runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath),
    );
    piece = await cc.create(program, { start: true });
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("navigate intent → optimistic-enact reconcile → ack → retirement (protocol.md §5; builtins.md §4)", async () => {
    const resultCell = cc.getResult(piece.getCell());
    await resultCell.pull();
    const space = piece.getCell().getAsNormalizedFullLink()
      .space as MemorySpace;
    // The client's OWN effects instance: scope "session", no key named
    // (T2.Q3 — the instance resolves from the authenticated session).
    const effectsCell = cc.runtime.getCellFromLink<SessionEffectsDocValue>({
      space,
      id: SERVER_EXECUTION_EFFECTS_DOC_ID as never,
      scope: "session",
      path: [],
    });

    if (!FLAG_ON) {
      // OFF arm, byte-identical: navigateTo runs client-side and
      // enacts locally; no effects doc exists anywhere.
      resultCell.key("go").send(undefined as never);
      await cc.runtime.idle();
      await waitUntil(
        () => navigations.length === 1,
        "the client-computed navigation",
      );
      await cc.runtime.storageManager.synced();
      await effectsCell.sync();
      const value = effectsCell.get();
      // STRICT (cubic review): the OFF arm writes NOTHING to the
      // effects doc — no channel exists, no served intent, no ack, no
      // retirement — so the instance must be strictly absent. Accepting
      // a present-but-empty doc would let a spuriously-created effects
      // instance (an OFF-arm effects-processing regression) pass the
      // very gate meant to catch it.
      assert(
        value === undefined,
        `no effects instance may exist in the OFF arm; got ${
          JSON.stringify(value)
        }`,
      );
      return;
    }

    // ---- the ON journey: fire → optimistic enact → intent → ack →
    // retire, with exactly ONE navigation end to end ----
    const statsBefore = await fetchStats();
    assert(statsBefore !== undefined, "the ON arm exposes servingLoop stats");
    resultCell.key("go").send(undefined as never);
    await cc.runtime.idle();

    // The OPTIMISTIC enactment (speculation.md §2's allowlisted
    // navigateTo): the navigation happens before the authoritative
    // intent's round-trip.
    await waitUntil(
      () => navigations.length === 1,
      "the optimistic enactment",
    );

    // The served intent lands in THIS session's instance and the
    // channel acks it (the authored `acks[nonce]` mark); the next wave
    // RETIRES the acked entry. Completion is judged by the ACK COUNTER
    // plus the drained-but-PRESENT instance (the retired footprint):
    // the intent's transient stay in the doc can be shorter than a
    // poll interval (intent → ack → retire across two fast waves), so
    // requiring the poll to SAMPLE it would flake — the effectAcks
    // increment is the proof the intent arrived and was acked, and it
    // can only have been acked by THIS session's channel (the
    // instance is session-scoped).
    let sawIntent = false;
    try {
      await waitUntil(
        async () => {
          const value = effectsCell.get();
          const entries = Array.isArray(value?.entries) ? value.entries : [];
          if (entries.length > 0) sawIntent = true;
          const acks = value?.acks ?? {};
          if (
            value === undefined || entries.length > 0 ||
            Object.keys(acks).length > 0
          ) {
            return false;
          }
          const stats = await fetchStats();
          return stats !== undefined &&
            stats.effectAcks > statsBefore.effectAcks;
        },
        "the intent to arrive, ack, and retire",
      );
    } catch (error) {
      // Diagnose WHERE the lifecycle stalled: the stream sidecar's
      // entry says whether the served side consequenced (or dropped)
      // the event; the effects instance says whether the intent
      // arrived/acked.
      const goLink = resultCell.key("go").getAsNormalizedFullLink();
      const sidecarCell = cc.runtime.getCellFromLink<StreamEventsDocValue>({
        space,
        id: streamEntriesDocId({
          id: goLink.id,
          path: [...goLink.path],
          ...(goLink.scope !== undefined ? { scope: goLink.scope } : {}),
        }) as never,
        scope: "space",
        path: [],
      });
      await sidecarCell.sync().catch(() => {});
      await effectsCell.sync().catch(() => {});
      throw new Error(
        `${(error as Error).message}\n  sawIntent=${sawIntent}` +
          `\n  sidecar=${JSON.stringify(sidecarCell.get())?.slice(0, 500)}` +
          `\n  effects=${JSON.stringify(effectsCell.get())?.slice(0, 300)}`,
      );
    }

    // Settle the space (the retirement wave included), then hold: the
    // convergence stands — ONE navigation, nothing resurrected.
    await cc.runtime.storageManager.synced();
    await waitForSettled(cc.runtime, space, 1, { timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assertEquals(
      navigations.length,
      1,
      "the optimistic enactment converged by nonce — no re-enactment",
    );

    // The ack was counted (serving-loop.md §7's effectAcks — the
    // amplification metric's exclusion, testing.md §4).
    const statsAfter = await fetchStats();
    assert(statsAfter !== undefined);
    assert(
      statsAfter.effectAcks > statsBefore.effectAcks,
      "the effect-channel ack was counted",
    );
  });
});
