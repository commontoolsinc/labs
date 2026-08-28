// OW45's lunch forever-park (CI run 33138358110, ON shard 7, the last
// ON-skip entry): the runner's cross-space CHILD replication
// (`replicate(parentSpace -> childSpace)`, runner.ts's CT-1687 call) can
// race the SIBLING replication that is still supplying the parent space
// itself — `compileOrGetPattern`'s content-cache hit fires
// `replicate(cached.space -> parentSpace)` fire-and-forget, and the child
// replication follows within the same handler run. The child's one-shot
// origin read then found the parent empty, threw "source closure
// unavailable in origin space", and nothing ever re-issued it (the
// documented retry is "the next child creation" — a user creates their
// profile once): the child space never received its program closure, its
// 40 demanded roots deferred `pattern-unloadable` forever (the OW46
// detector's 80-warn signature), the profile name never resolved, and the
// host's `#lp-join-button` never rendered.
//
// The race is deterministic-by-construction here: the child replication is
// issued synchronously after the sibling, and its origin read is strictly
// less work than the sibling's read-plus-write, so unfixed it ALWAYS reads
// the parent space before the sibling writes it. The fix: a replication
// awaits the earlier-registered replications INTO its origin space before
// reading (registration-ordered tickets — acyclic, event-driven, no
// timers).
//
// Layered-view note (why the race needs a SIBLING and not a wave): a
// same-runtime compile's E4-awaited write-back into a wave's own space is
// readable through the ordinary read path even before the wave commits
// (executor-wave.ts's layered view) — verified while diagnosing this — so
// only a supplier that has not yet ISSUED its writes can leave the origin
// empty. The in-flight sibling is exactly that supplier.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import {
  getCompileCacheRuntimeVersion,
  loadCompiledClosure,
  loadVerifiedSourceClosure,
} from "../src/compilation-cache/cell-cache.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("replication sibling race test");
const spaceA = signer.did() as MemorySpace; // where the compile lands
const spaceB = (await Identity.fromPassphrase(
  "replication sibling race parent space",
)).did() as MemorySpace; // the parent space, supplied by the sibling
const spaceC = (await Identity.fromPassphrase(
  "replication sibling race child space",
)).did() as MemorySpace; // the child space (the lunch red's profile space)
const spaceD = (await Identity.fromPassphrase(
  "replication sibling race empty origin",
)).did() as MemorySpace; // an origin nothing ever supplies
const spaceE = (await Identity.fromPassphrase(
  "replication sibling race dead target",
)).did() as MemorySpace;

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern(() => ({ label: 'replicated child' }));",
      ].join("\n"),
    },
  ],
};

describe("closure replication: the in-flight sibling supplier race", () => {
  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(async () => {
    server = newSharedServer();
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
    // World-writable genesis for the replication targets: the write-backs
    // into them are ordinary client-shaped commits by `signer`.
    for (const space of [spaceB, spaceC, spaceE]) {
      Engine.applyCommit(await server.engineForSpace(space), {
        sessionId: "test-genesis-session",
        space,
        principal: space,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: `of:${space}`,
            value: { value: { "did:key:alice": "OWNER", "*": "WRITE" } },
          }],
        },
      });
    }
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  /** The closure identities readable for `entry` in `space` on a fresh
   * transaction (the replication's own read shape). */
  const readableClosure = async (
    rt: Runtime,
    space: MemorySpace,
    entryIdentity: string,
  ): Promise<{ source: string[]; compiled: string[] }> => {
    const runtimeVersion = await getCompileCacheRuntimeVersion();
    const readTx = rt.edit();
    try {
      const source = await loadVerifiedSourceClosure(
        rt,
        space,
        entryIdentity,
        readTx,
      );
      const compiled = runtimeVersion === undefined
        ? new Map<string, unknown>()
        : await loadCompiledClosure(
          rt,
          space,
          entryIdentity,
          { runtimeVersion },
          readTx,
        );
      return {
        source: [...(source?.keys() ?? [])],
        compiled: [...compiled.keys()],
      };
    } finally {
      readTx.abort?.("replication race pin read");
    }
  };

  it(
    "a child replication issued while the sibling supplying its origin is " +
      "still in flight materializes the child space anyway (OW45 lunch " +
      "park: A -> B in flight, B -> C must wait for it, not one-shot-die)",
    async () => {
      // The compile's closure lands in A (E4-awaited).
      const pattern = await runtime.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      const entry = runtime.patternManager.getArtifactEntryRef(pattern);
      if (entry === undefined) throw new Error("compile produced no entry ref");
      await runtime.patternManager.flushCompileCacheWrites();

      // The SIBLING: supply the parent space B from A — fire-and-forget,
      // in flight (the content-cache hit's shape).
      runtime.patternManager.replicatePatternToSpace(pattern, spaceB, spaceA);
      // The CHILD replication, issued synchronously after — the runner's
      // CT-1687 call inside the same handler run. Its origin is B, whose
      // supplier is still mid-read: unfixed, its one read of B finds
      // nothing and the replication dies; C never becomes loadable — the
      // lunch red's `pattern-unloadable` forever-park.
      runtime.patternManager.replicatePatternToSpace(pattern, spaceC, spaceB);

      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      // THE PIN: the child space holds the closure and a fresh runtime
      // loads the pattern from it by identity — exactly what the child
      // space's structure load needs to unpark.
      const childState = await readableClosure(runtime, spaceC, entry.identity);
      expect(childState.source).toContain(entry.identity);
      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      try {
        const loaded = await rt2.patternManager.loadPatternByIdentity(
          entry.identity,
          entry.symbol,
          spaceC,
        );
        expect(loaded).toBeDefined();
      } finally {
        await rt2.dispose();
      }
    },
  );

  it(
    "an origin with NO supplier still fails loud and settles — the " +
      "sibling await must not turn genuine absence into a hang",
    async () => {
      const pattern = await runtime.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      const entry = runtime.patternManager.getArtifactEntryRef(pattern);
      if (entry === undefined) throw new Error("compile produced no entry ref");
      await runtime.patternManager.flushCompileCacheWrites();

      // Origin D was never written by anyone; nothing is in flight into it.
      runtime.patternManager.replicatePatternToSpace(pattern, spaceE, spaceD);
      // The one-shot failure contract for genuine absence stands: the
      // replication settles (a hang here would wedge every
      // flushCompileCacheWrites caller — the client durability barrier's
      // territory) and the target stays empty.
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();
      const deadTarget = await readableClosure(runtime, spaceE, entry.identity);
      expect(deadTarget.source).toEqual([]);
      expect(deadTarget.compiled).toEqual([]);
    },
  );
});
