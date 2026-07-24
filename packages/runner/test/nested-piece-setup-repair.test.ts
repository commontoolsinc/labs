import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

// A nested/embedded piece — a profile mounted via a `#wish`, say — is
// instantiated by the runtime's start walk WITHOUT a setup phase and with no
// pattern watcher armed to self-heal. If its stored doc predates the pattern's
// setup (here: set up for V1, then re-pointed at the handler-bearing V3 whose
// `bump` stream marker the V1 doc never materialized), instantiation throws
// "Handler used as lift … marker was never written". Runner.startCore's initial
// instantiation re-runs the pinned pattern's OWN setup on that failure (gated by
// systemPatternAutoUpdate) and retries — the same repair the home ROOT gets in
// startEnsuredDefaultPattern, reachable at last for the nested pieces that never
// pass through the PieceController. The root itself is EXCLUDED (the controller
// owns it); a nested piece is never a space's defaultPattern, so it heals here.

const signer = await Identity.fromPassphrase("nested-piece-setup-repair");
const space = signer.did();

const V1_NO_HANDLER = [
  "import { Writable, pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { count: Writable<number> }>(() => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { count };",
  "});",
  "",
].join("\n");

// Identical result shape plus a `bump` handler — its { \"$stream\": true } marker
// is absent from a doc set up for V1, so instantiating V3 over that doc bricks.
const V3_WITH_HANDLER = [
  "import { Writable, handler, pattern } from 'commonfabric';",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "export default pattern<Record<string, never>, { count: Writable<number> }>(() => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { count, bump: bump({ count }) };",
  "});",
  "",
].join("\n");

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

describe("nested-piece cold-start setup repair", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const newRuntime = (systemPatternAutoUpdate: boolean) =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { systemPatternAutoUpdate },
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  // Build the bricked nested piece: set up for V1 (data + V1 markers), then
  // re-point patternIdentity at V3 without re-running setup, so V3's `bump`
  // stream marker is missing. Returns the stopped piece cell, ready to start.
  const brickedNestedPiece = async (rt: Runtime) => {
    const tx = rt.edit();
    const pm = rt.patternManager;
    const v1 = await pm.compilePattern(programOf(V1_NO_HANDLER), { space, tx });
    const v3 = await pm.compilePattern(programOf(V3_WITH_HANDLER), {
      space,
      tx,
    });
    const v3Ref = pm.getArtifactEntryRef(v3)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "nested-piece-brick",
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, {}, cell);
    await tx.commit();
    await running.pull();
    // Stop, then move the pinned identity to V3 with NO setup for it — the
    // exact "identity moved without setup" durable state, one level down.
    rt.runner.stop(cell);
    const tx2 = rt.edit();
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: v3Ref.identity,
      symbol: v3Ref.symbol,
    });
    await tx2.commit();
    // It is not the space's defaultPattern, so the runner repair (not the
    // controller) is what must heal it.
    return { cell, v3Ref };
  };

  it("bricks on start when the repair flag is OFF (locks in the gap)", async () => {
    const rt = newRuntime(false);
    try {
      const { cell } = await brickedNestedPiece(rt);
      await expect(rt.start(cell)).rejects.toThrow("marker was never written");
    } finally {
      await rt.dispose();
    }
  });

  it("heals a nested piece by re-running its setup on start (flag ON)", async () => {
    const rt = newRuntime(true);
    try {
      const { cell, v3Ref } = await brickedNestedPiece(rt);
      // Starts WITHOUT throwing: the setup repair materializes the missing
      // internal cells for V3, then instantiation succeeds.
      const started = await rt.start(cell);
      expect(started).toBe(true);
      await cell.pull();
      // The identity is still V3 (a re-setup, not a roll-forward)…
      const idRaw = (cell as unknown as {
        getMetaRaw: (k: string) => unknown;
      }).getMetaRaw("patternIdentity") as { identity?: string } | undefined;
      expect(idRaw?.identity).toBe(v3Ref.identity);
      // …and the once-missing handler stream now fires end to end.
      const before = (cell.getAsQueryResult() as { count: number }).count;
      (cell.key("bump") as unknown as { send: (e: unknown) => void }).send({});
      await cell.pull();
      const after = (cell.getAsQueryResult() as { count: number }).count;
      expect(after).toBe(before + 1);
    } finally {
      await rt.dispose();
    }
  });
});
