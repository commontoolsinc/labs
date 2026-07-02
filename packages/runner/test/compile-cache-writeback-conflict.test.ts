import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import { setCompileCacheRuntimeVersionForTesting } from "../src/compilation-cache/cell-cache.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

// Shared-server helper (same shape as cell-cache.test.ts): several managers —
// each a SEPARATE client replica — over ONE in-process memory server, so a
// fresh runtime is genuinely cold the way a fresh browser worker is.
class SharedServerStorageManager extends EmulatedStorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager._sharedServer = server;
    return manager;
  }
  private _sharedServer!: MemoryV2Server.Server;
  protected override server(): MemoryV2Server.Server {
    return this._sharedServer;
  }
}

const newSharedServer = () =>
  new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const signer = await Identity.fromPassphrase("writeback conflict test");
const space = signer.did();

// CT-1824 regression: a runtime-version bump sends loads through the
// cold-load recovery path (recompile + write-back). The write-back re-writes
// version-independent source docs whose cell-layer-derived documents (link/
// import-edge cells) already exist from the original compile — documents a
// cold replica has never read. The commit then carries stale seq-0 reads and
// fails with a ConflictError; before the fix, editWithRetry re-ran
// immediately against the same stale replica, so every retry failed
// identically, the compiled cache never healed, and EVERY subsequent cold
// boot recompiled. The conflict's `readyToRetry` catch-up gate is the
// designed remedy; editWithRetry must await it like the scheduler does
// (scheduler/action-run.ts).
describe("compile-cache write-back after a runtime-version bump", () => {
  it("recovery write-back persists despite pre-existing docs on a cold replica", async () => {
    const server = newSharedServer();
    const program = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { pattern, lift } from 'commonfabric';",
          "const inc = lift((x:number)=>x+1);",
          "export default pattern<{ value: number }>(({ value }) => {",
          "  return { result: inc(value) };",
          "});",
        ].join("\n"),
      }],
    };

    // Version A: compile + persist (source docs, their derived link cells,
    // and compiled docs keyed under vA).
    const restoreVersion = setCompileCacheRuntimeVersionForTesting(
      "test-version-A",
    );
    const smA = SharedServerStorageManager.connectTo(server, { as: signer });
    const runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smA,
    });
    let smB: SharedServerStorageManager | undefined;
    let runtimeB: Runtime | undefined;
    let smC: SharedServerStorageManager | undefined;
    let runtimeC: Runtime | undefined;
    try {
      const txA = runtimeA.edit();
      const compiled = await runtimeA.patternManager.compilePattern(program, {
        space,
        tx: txA,
      });
      const ref = runtimeA.patternManager.getArtifactEntryRef(compiled)!;
      const entryIdentity = ref.identity;
      const symbol = ref.symbol;
      await runtimeA.patternManager.flushCompileCacheWrites();
      await txA.commit();
      await smA.synced();

      // Version B ("the compiler shipped"): a COLD replica finds no compiled
      // docs under vB and takes the recovery path — recompile, then write
      // back source docs (which already exist server-side, with their derived
      // cells this replica has never read) plus compiled docs under vB.
      setCompileCacheRuntimeVersionForTesting("test-version-B");
      smB = SharedServerStorageManager.connectTo(server, { as: signer });
      runtimeB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smB,
      });
      const recovered = await runtimeB.patternManager.loadPatternByIdentity(
        entryIdentity,
        symbol,
        space,
      );
      expect(recovered).toBeDefined();
      // Proof B took the recovery path (a warm by-identity closure hit would
      // have incremented byIdentityHits; recovery does not).
      expect(runtimeB.patternManager.getCompileCacheStats().byIdentityHits)
        .toBe(0);
      // The write-back is fire-and-forget from the load's perspective; force
      // it to settle so its outcome is observable.
      await runtimeB.patternManager.flushCompileCacheWrites();
      await smB.synced();

      // Healing proof: a THIRD cold replica at vB warm-hits the compiled
      // closure B wrote back — no recovery, no recompile. Before the fix,
      // B's write-back died on a deterministic ConflictError (stale seq-0
      // read of a pre-existing derived doc), so C recompiled again — and so
      // did every cold boot after it, forever.
      smC = SharedServerStorageManager.connectTo(server, { as: signer });
      runtimeC = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smC,
      });
      const warm = await runtimeC.patternManager.loadPatternByIdentity(
        entryIdentity,
        symbol,
        space,
      );
      expect(warm).toBeDefined();
      expect(runtimeC.patternManager.getCompileCacheStats().byIdentityHits)
        .toBeGreaterThan(0);
    } finally {
      restoreVersion();
      await runtimeC?.dispose();
      await runtimeB?.dispose();
      await runtimeA.dispose();
      await smC?.close();
      await smB?.close();
      await smA.close();
      await server.close();
    }
  });
});

// Direct contract test for the fix: a conflict's `readyToRetry` catch-up gate
// must be awaited BEFORE the retry re-runs, and the retry then succeeds.
describe("editWithRetry conflict catch-up", () => {
  it("awaits readyToRetry between attempts and then succeeds", async () => {
    const server = newSharedServer();
    const sm = SharedServerStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const events: string[] = [];
    let commits = 0;
    const fakeTx = () => ({
      tx: {},
      abort: () => {},
      commit: () => {
        commits++;
        if (commits === 1) {
          return Promise.resolve({
            error: {
              name: "ConflictError",
              message:
                "stale confirmed read: of:test at seq 0 conflicted with seq 9",
              readyToRetry: () => {
                events.push("caught-up");
                return Promise.resolve();
              },
            },
          });
        }
        return Promise.resolve({});
      },
    });
    // deno-lint-ignore no-explicit-any
    (runtime as any).edit = () => fakeTx();
    // deno-lint-ignore no-explicit-any
    (runtime as any).prepareTxForCommit = () => {};
    try {
      const result = await runtime.editWithRetry(() => {
        events.push(`attempt-${commits + 1}`);
      });
      expect(result.error).toBeUndefined();
      // The catch-up gate resolves BEFORE the second attempt runs.
      expect(events).toEqual(["attempt-1", "caught-up", "attempt-2"]);
    } finally {
      await runtime.dispose();
      await sm.close();
      await server.close();
    }
  });
});
