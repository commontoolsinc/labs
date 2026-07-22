import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getPatternIdentityRef,
  resolveEntryIdentity,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createSession, Identity } from "@commonfabric/identity";
import { PieceManager } from "../src/manager.ts";
import {
  DEFAULT_APP_PATTERN_URL,
  PiecesController,
} from "../src/ops/pieces-controller.ts";

// Golden replay: the state-survival gate the flag flip (#4619) is waiting on.
//
// The other swap tests prove the ENTITY and patternIdentity swap in place; this
// one proves the thing those don't: durable state seeded under version N is
// still there, intact, after the root rolls to N+1 — no crash, no loss. It
// stands in for "open a real non-home space, add some notes, ship a new
// default-app, reopen" — the scenario both reviewers asked to see mechanically
// verified before this defaults on.

const signer = await Identity.fromPassphrase("default-app golden replay");

// A default-app-SHAPED root: it OWNS a `pieces` list via `new Writable([])` —
// exactly how default-app owns `allPieces` — and derives a reactive `summary`
// from it. The list is kept at the same stable position across versions, so a
// correct in-place swap must carry the seeded pieces across untouched (owned
// cells are addressed by a stable cause, not by pattern identity).
//
// `version` is the ONLY authored difference between V1 and V2, and it lives
// INSIDE the reactive `summary` closure — re-instantiation re-wires reactive
// nodes (not static result literals), so a version marker only shows through the
// swap if the new code's own computation runs. `summary` therefore proves two
// things at once: the new code is live, and it can read the state seeded under
// the old code.
const rootSource = (version: string) =>
  [
    "import { pattern, computed, Writable } from 'commonfabric';",
    "export default pattern<void>(() => {",
    "  const pieces = new Writable<string[]>([]);",
    "  return {",
    "    pieces,",
    `    summary: computed(() => \`${version}:\` + pieces.get().length),`,
    "  };",
    "});",
    "",
  ].join("\n");

const ROOT_V1 = rootSource("v1");
const ROOT_V2 = rootSource("v2");

const SEEDED_PIECES = ["note:groceries", "note:standup", "notebook:trip"];

/** Content identity a toolshed would serve for `source`. */
function identityForSource(source: string): Promise<string> {
  return resolveEntryIdentity(
    DEFAULT_APP_PATTERN_URL,
    (name) =>
      name === DEFAULT_APP_PATTERN_URL
        ? Promise.resolve(source)
        : Promise.reject(new Error(`not found: ${name}`)),
  );
}

interface StubControls {
  setSource(source: string): void;
  restore(): void;
}

function installFetchStub(): StubControls {
  const original = globalThis.fetch;
  let source = ROOT_V1;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const url = new URL(href);

    if (url.pathname === DEFAULT_APP_PATTERN_URL) {
      if (url.searchParams.has("identity")) {
        return new Response(await identityForSource(source), {
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response(source, {
        headers: { "content-type": "text/typescript-jsx" },
      });
    }

    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    setSource: (s) => (source = s),
    restore: () => (globalThis.fetch = original),
  };
}

describe("default-app golden replay (state survives an in-place roll-forward)", () => {
  let stub: StubControls;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;
  let controller: PiecesController;

  beforeEach(async () => {
    stub = installFetchStub();
    stub.setSource(ROOT_V1);
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      experimental: { systemPatternAutoUpdate: true },
    });
    const session = await createSession({
      identity: signer,
      spaceName: "golden-replay-" + crypto.randomUUID(),
    });
    manager = new PieceManager(session, runtime);
    await manager.synced();
    controller = new PiecesController(manager);
  });

  afterEach(async () => {
    try {
      await controller?.dispose();
    } catch { /* already disposed */ }
    await storageManager?.close();
    stub.restore();
  });

  it("carries seeded state across the N→N+1 swap without crashing", async () => {
    // N: instantiate the default-app-shaped root.
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    const rootLinkBefore = JSON.stringify(root.getAsLink());
    const idV1 = getPatternIdentityRef(root)?.identity;
    expect(idV1).toBe(await identityForSource(ROOT_V1));

    // Keep a live subscription on the root's reactive `summary`, the way a
    // mounted shell would. The graph is pull-based; without a standing consumer
    // the re-instantiated pattern would be built but never execute, and we would
    // only be testing the meta swap (which the sibling tests already cover), not
    // that the new code actually runs and re-reads the seeded state. The sink
    // also delivers the RESOLVED computed value (a bare `.get()` on a computed
    // result key yields the unresolved alias), which we latch here.
    let summary: unknown;
    const cancelSink = root.key("summary").sink((value) => {
      summary = value;
    });

    // Seed representative state: add "pieces" to the running root, the way a
    // user filling a fresh space would, and confirm they landed durably.
    await runtime.editWithRetry((tx) => {
      root.withTx(tx).key("pieces").set([...SEEDED_PIECES]);
    });
    await runtime.idle();
    expect(root.key("pieces").get()).toEqual(SEEDED_PIECES);
    // V1's reactive summary sees the seeded state.
    expect(summary).toBe("v1:" + SEEDED_PIECES.length);

    // N+1: the toolshed now serves a newer default-app (its `summary` logic
    // changed). Roll forward in place.
    stub.setSource(ROOT_V2);
    expect(await controller.checkAndUpdateDefaultPattern()).toBe("updated");
    // Let the pattern watcher observe the meta change and re-instantiate, then
    // pull the root so the new instance actually executes (pull-based graph).
    await runtime.idle();
    const rolled = (await manager.getDefaultPattern(false))!;
    await rolled.pull();
    await runtime.idle();

    // Same piece entity — the root was rewritten in place, not re-minted.
    expect(JSON.stringify(rolled.getAsLink())).toBe(rootLinkBefore);

    // The identity advanced to V2.
    const idV2 = getPatternIdentityRef(rolled)?.identity;
    expect(idV2).toBe(await identityForSource(ROOT_V2));
    expect(idV2).not.toBe(idV1);

    // The crux: the state seeded under V1 survived the swap, intact and in
    // order. No crash, no loss.
    expect(rolled.key("pieces").get()).toEqual(SEEDED_PIECES);

    // And the NEW code is actually running over that survived state: the V2
    // computation (`v2:`, not `v1:`) reports the seeded count. One assertion,
    // both properties — new code live + old state readable by it.
    expect(summary).toBe("v2:" + SEEDED_PIECES.length);

    cancelSink();
  });
});
