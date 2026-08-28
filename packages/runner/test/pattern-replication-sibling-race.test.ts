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
// the parent space before the sibling writes it. Two fixes cover the two
// supplier geometries, and this file pins both:
//
// - the SIBLING AWAIT: a replication awaits the earlier-registered
//   replications INTO its origin space before reading
//   (registration-ordered tickets — acyclic, event-driven, no timers);
// - the FALLBACK ORIGIN (the direct-CI probe 2 geometry, run 33160430927:
//   the parent space never receives the closure AT ALL, because
//   `loadPatternByIdentity` serves the pattern from the in-memory
//   artifact index with no per-space persist when another space's compile
//   warmed it first): on a dry origin the replication retries its read
//   against the spaces this manager durably persisted the entry into —
//   content-addressed, so the copy is byte-identical and the verified
//   read stays fail-closed.
//
// Layered-view note (why the race needs a missing SUPPLIER and not a
// wave): a same-runtime compile's E4-awaited write-back into a wave's own
// space is readable through the ordinary read path even before the wave
// commits (executor-wave.ts's layered view) — verified while diagnosing
// this — so only a supplier that never issued its writes can leave the
// origin empty. The in-flight sibling and the never-persisting
// index-served flow are exactly those suppliers.

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
  "replication sibling race fallback target",
)).did() as MemorySpace; // the fallback-supplied target
const spaceF = (await Identity.fromPassphrase(
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

// A LIBRARY module and an importer: compiled together, the persist's ENTRY
// is the importer while the lib's pattern carries the LIB module's own
// content identity — the CI probe shape, where the replicated entry is a
// MODULE of the closure some other space's persist wrote.
const LIB_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export const libPattern = pattern(() => ({ label: 'library child' }));",
].join("\n");
const PROGRAM_WITH_LIB: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "import { libPattern } from './lib.tsx';",
        "export default pattern(() => ({ label: 'importer', libPattern }));",
      ].join("\n"),
    },
    { name: "/lib.tsx", contents: LIB_SOURCE },
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
    for (const space of [spaceB, spaceC, spaceE, spaceF]) {
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
    "a DRY heuristic origin falls back to a recorded persist target — the " +
      "CI probe-2 geometry: the parent space never received the closure " +
      "(the in-memory index served the pattern with no per-space persist), " +
      "and the child space must still materialize from a space the manager " +
      "durably persisted into",
    async () => {
      // The compile persists the closure into A — the manager records A as
      // a durable persist target for this entry.
      const pattern = await runtime.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      const entry = runtime.patternManager.getArtifactEntryRef(pattern);
      if (entry === undefined) throw new Error("compile produced no entry ref");
      await runtime.patternManager.flushCompileCacheWrites();

      // Origin D is DRY: nothing ever persisted into it and nothing is in
      // flight toward it — the exact CI shape (the parent ran the pattern
      // from the in-memory index; its space holds no closure). Unfixed, the
      // one-shot read of D dies and E parks pattern-unloadable forever.
      runtime.patternManager.replicatePatternToSpace(pattern, spaceE, spaceD);
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      // THE PIN: E holds the closure — copied from the recorded target A,
      // byte-identical under content addressing, integrity-gated on read.
      const target = await readableClosure(runtime, spaceE, entry.identity);
      expect(target.source).toContain(entry.identity);
      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      try {
        const loaded = await rt2.patternManager.loadPatternByIdentity(
          entry.identity,
          entry.symbol,
          spaceE,
        );
        expect(loaded).toBeDefined();
      } finally {
        await rt2.dispose();
      }
    },
  );

  it(
    "the fallback keys by MODULE identity, not just the persist entry — " +
      "a pattern served from the in-memory index carries its own module's " +
      "identity while the space was supplied by its IMPORTER's persist " +
      "(the direct-CI probe-3 geometry)",
    async () => {
      // The main runtime compiles the IMPORTER program into A: the
      // persist's entry is the importer, and the lib rides the closure as
      // a module (one addressable doc per module).
      const importer = await runtime.patternManager.compileOrGetPattern(
        PROGRAM_WITH_LIB,
        spaceA,
      );
      const importerEntry = runtime.patternManager.getArtifactEntryRef(
        importer,
      );
      if (importerEntry === undefined) throw new Error("no importer entry");
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      // Learn the lib MODULE's content identity from the persisted closure
      // itself (the module doc whose filename is /lib.tsx).
      let libIdentity: string | undefined;
      {
        const readTx = runtime.edit();
        try {
          const closure = await loadVerifiedSourceClosure(
            runtime,
            spaceA,
            importerEntry.identity,
            readTx,
          );
          for (const [identity, doc] of closure ?? []) {
            if (doc.filename === "/lib.tsx") libIdentity = identity;
          }
        } finally {
          readTx.abort?.("lib identity lookup");
        }
      }
      if (libIdentity === undefined) throw new Error("no lib identity");
      expect(libIdentity).not.toBe(importerEntry.identity);

      // The lib pattern arrives the CI way: served from the in-memory
      // artifact index by its own module identity — no per-space persist
      // happens on this path, so the named space (dry D) stays dry.
      const libPattern = await runtime.patternManager.loadPatternByIdentity(
        libIdentity,
        "libPattern",
        spaceD,
      );
      expect(libPattern).toBeDefined();

      // The child replication for the index-served pattern, origin dry:
      // its entry is the LIB module's identity. With entry-only keying the
      // fallback map has no row for it and the replication one-shot-dies;
      // with module keying it copies from A.
      runtime.patternManager.replicatePatternToSpace(
        libPattern as never,
        spaceC,
        spaceD,
      );
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();
      const target = await readableClosure(runtime, spaceC, libIdentity);
      expect(target.source).toContain(libIdentity);
    },
  );

  it(
    "an entry with NO recorded persist anywhere still fails loud and " +
      "settles — neither the sibling await nor the fallback may turn " +
      "genuine absence into a hang or a fabricated copy",
    async () => {
      const pattern = await runtime.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      const entry = runtime.patternManager.getArtifactEntryRef(pattern);
      if (entry === undefined) throw new Error("compile produced no entry ref");
      await runtime.patternManager.flushCompileCacheWrites();

      // A SECOND manager holds the same pattern object (the artifact entry
      // ref rides a module-level side table) but has persisted NOTHING —
      // no fallback targets exist for it, and origin D is dry.
      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      try {
        rt2.patternManager.replicatePatternToSpace(pattern, spaceF, spaceD);
        // The loud one-shot failure contract stands: the replication
        // settles (a hang here would wedge every flushCompileCacheWrites
        // caller — the client durability barrier's territory) and the
        // target stays empty.
        await rt2.patternManager.flushCompileCacheWrites();
        await storageManager.synced();
        const deadTarget = await readableClosure(rt2, spaceF, entry.identity);
        expect(deadTarget.source).toEqual([]);
        expect(deadTarget.compiled).toEqual([]);
      } finally {
        await rt2.dispose();
      }
    },
  );
});
