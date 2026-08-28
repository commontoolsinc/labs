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
// the parent space before the sibling writes it. Three fixes cover the
// three supplier geometries the arc's direct-CI probes mapped, and this
// file pins all three:
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
//   read stays fail-closed;
// - the IN-FLIGHT-COMPILE AWAIT (the direct-CI probe 4 geometry, run
//   33165960083: the supplier compile itself is still mid-flight at
//   consult time, so no persist exists anywhere and the fallback map is
//   CORRECTLY dry): on a dry origin AND dry map, the replication awaits a
//   snapshot of the in-flight compile registries once (cold compiles +
//   by-identity loads; never `compileCacheWrites`, its own set), then
//   re-consults; genuine absence still throws the same loud one-shot
//   failure.
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
import { getLogger, type LogMessage } from "@commonfabric/utils/logger";
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
const spaceG = (await Identity.fromPassphrase(
  "replication sibling race in-flight compile target",
)).did() as MemorySpace; // where the GATED supplier compile persists
const spaceH = (await Identity.fromPassphrase(
  "replication sibling race second fallback candidate",
)).did() as MemorySpace; // the candidate AFTER the throwing one

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
    for (const space of [spaceB, spaceC, spaceE, spaceF, spaceG, spaceH]) {
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

  /** Run `body` with the `pattern-manager` logger's error lines captured,
   * resolved exactly as the logger resolves them (its messages are lazy
   * closures). The logger is a process-wide singleton, so the spy is an own
   * property shadowing the prototype method, deleted again afterwards, and
   * it delegates so the line still prints. */
  const captureManagerErrors = async (
    body: () => Promise<void>,
  ): Promise<{ key: string; line: string }[]> => {
    const managerLogger = getLogger("pattern-manager");
    const realError = managerLogger.error.bind(managerLogger);
    const captured: { key: string; line: string }[] = [];
    const spied = managerLogger as unknown as {
      error?: (key: string, ...messages: LogMessage[]) => void;
    };
    spied.error = (key: string, ...messages: LogMessage[]) => {
      const parts = messages.flatMap((message) => {
        const resolved = typeof message === "function"
          ? (message as () => unknown)()
          : message;
        return Array.isArray(resolved) ? resolved : [resolved];
      });
      captured.push({ key, line: parts.map(String).join(" ") });
      realError(key, ...messages);
    };
    try {
      await body();
    } finally {
      delete spied.error;
    }
    return captured;
  };

  /** Capture the `pattern-manager` logger's WARN and ERROR lines, resolved
   * exactly as the logger resolves them (lazy closures), invoking `onLine`
   * synchronously per line — the in-flight-supplier step below uses that to
   * release its compile gate the moment the replication's dry consult
   * announces itself. Same own-property-spy-over-the-singleton shape as
   * `captureManagerErrors` (which stays untouched: the existing steps pin
   * against it byte-identically); both spies delegate so the lines still
   * print. */
  const captureManagerLines = async (
    body: () => Promise<void>,
    onLine?: (
      entry: { level: "warn" | "error"; key: string; line: string },
    ) => void,
  ): Promise<{ level: "warn" | "error"; key: string; line: string }[]> => {
    const managerLogger = getLogger("pattern-manager");
    const captured: { level: "warn" | "error"; key: string; line: string }[] =
      [];
    const spied = managerLogger as unknown as {
      warn?: (key: string, ...messages: LogMessage[]) => void;
      error?: (key: string, ...messages: LogMessage[]) => void;
    };
    const resolveLine = (messages: LogMessage[]): string =>
      messages.flatMap((message) => {
        const resolved = typeof message === "function"
          ? (message as () => unknown)()
          : message;
        return Array.isArray(resolved) ? resolved : [resolved];
      }).map(String).join(" ");
    for (const level of ["warn", "error"] as const) {
      const real = managerLogger[level].bind(managerLogger);
      spied[level] = (key: string, ...messages: LogMessage[]) => {
        const entry = { level, key, line: resolveLine(messages) };
        captured.push(entry);
        onLine?.(entry);
        real(key, ...messages);
      };
    }
    try {
      await body();
    } finally {
      delete spied.warn;
      delete spied.error;
    }
    return captured;
  };

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
      await storageManager.synced();

      // BOTH replications run from a SECOND manager sharing the storage —
      // the artifact entry ref rides a module-level side table, so it holds
      // the same pattern object while having persisted NOTHING itself, i.e.
      // its FALLBACK-ORIGIN map is empty. That is the point: the compiling
      // manager recorded A as a persist target for this entry, so on THIS
      // manager the fallback would rescue the child replication from A even
      // with the sibling await deleted, and the mutation that removes the
      // await alone would leave this step green. Here the only thing that
      // can supply C is the await on the in-flight sibling — so the await is
      // load-bearing on its own and a refactor that drops it reds this step.
      const supplier = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      try {
        // The SIBLING: supply the parent space B from A — fire-and-forget,
        // in flight (the content-cache hit's shape).
        supplier.patternManager.replicatePatternToSpace(
          pattern,
          spaceB,
          spaceA,
        );
        // The CHILD replication, issued synchronously after — the runner's
        // CT-1687 call inside the same handler run. Its origin is B, whose
        // supplier is still mid-read: unfixed, its one read of B finds
        // nothing and the replication dies; C never becomes loadable — the
        // lunch red's `pattern-unloadable` forever-park.
        supplier.patternManager.replicatePatternToSpace(
          pattern,
          spaceC,
          spaceB,
        );

        await supplier.patternManager.flushCompileCacheWrites();
        await storageManager.synced();

        // THE PIN: the child space holds the closure and a fresh runtime
        // loads the pattern from it by identity — exactly what the child
        // space's structure load needs to unpark.
        const childState = await readableClosure(
          runtime,
          spaceC,
          entry.identity,
        );
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
      } finally {
        await supplier.dispose();
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
        const errors = await captureManagerErrors(async () => {
          rt2.patternManager.replicatePatternToSpace(pattern, spaceF, spaceD);
          // The loud one-shot failure contract stands: the replication
          // settles (a hang here would wedge every flushCompileCacheWrites
          // caller — the client durability barrier's territory) and the
          // target stays empty.
          await rt2.patternManager.flushCompileCacheWrites();
          await storageManager.synced();
        });
        const deadTarget = await readableClosure(rt2, spaceF, entry.identity);
        expect(deadTarget.source).toEqual([]);
        expect(deadTarget.compiled).toEqual([]);

        // LOUD is half the contract, and the half a settle-and-empty
        // assertion cannot see: turning the failing throw into a silent
        // return also leaves the target empty. `closure-replication-failed`
        // is the discriminating event every CI probe classification in this
        // arc hung on — losing it blinds the next forensics pass with no
        // lane going red. Exactly one line, because the replication is
        // one-shot: no retry loop may hide behind the same log key.
        const failures = errors.filter((error) =>
          error.key === "closure-replication-failed"
        );
        expect(failures.length).toBe(1);
        expect(failures[0].line).toContain(`entry=${entry.identity}`);
        expect(failures[0].line).toContain(`from=${spaceD}`);
        expect(failures[0].line).toContain(`to=${spaceF}`);
        // The legacy reason string, preserved verbatim so the forensics
        // greps written against the CI artifacts keep matching.
        expect(failures[0].line).toContain(
          "source closure unavailable in origin space",
        );
      } finally {
        await rt2.dispose();
      }
    },
  );

  it(
    "the supplier compile is still MID-FLIGHT at consult time — the " +
      "direct-CI probe-4 geometry (run 33165960083): no persist has " +
      "completed anywhere, the module-keyed fallback map is CORRECTLY " +
      "dry, and the replication must await the in-flight compile " +
      "registries once and re-consult instead of one-shot-dying",
    async () => {
      // R1's compile supplies only the pattern OBJECT (the entry ref rides
      // the module-level side table). Everything else runs on a SECOND
      // manager whose fallback map is empty and whose origin has no
      // replications into it, ever — the F1 lesson: neither a pre-populated
      // map nor an older-sibling await may be able to rescue the child, so
      // the once-await is load-bearing alone and a refactor that drops it
      // reds this step.
      const pattern = await runtime.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      const entry = runtime.patternManager.getArtifactEntryRef(pattern);
      if (entry === undefined) throw new Error("compile produced no entry ref");
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      const harnessSpy = rt2.harness as unknown as {
        compileToRecordGraph?: (...args: unknown[]) => Promise<unknown>;
      };
      try {
        // GATE rt2's compile pipeline: the first compileToRecordGraph call
        // signals that it started, then parks until released. The supplier
        // compile is then provably IN FLIGHT (it registered in
        // `inProgressCompilations` synchronously at `compileOrGetPattern`)
        // and provably PRE-PERSIST (its E4 persist sits far behind the
        // gate), which is exactly probe 4's timeline: compile waves
        // running, zero persists anywhere, the fallback map genuinely
        // empty. No sleeps anywhere — the gate releases on the
        // replication's own announcement (below), and the fix's
        // allSettled-then-re-consult is what makes the record visible
        // before the re-read, deterministically.
        const compileStarted = Promise.withResolvers<void>();
        const compileReleased = Promise.withResolvers<void>();
        const realCompile = harnessSpy.compileToRecordGraph;
        if (realCompile === undefined) throw new Error("no harness compile");
        const boundCompile = realCompile.bind(rt2.harness);
        let gated = true;
        harnessSpy.compileToRecordGraph = async (...args: unknown[]) => {
          if (gated) {
            gated = false;
            compileStarted.resolve();
            await compileReleased.promise;
          }
          return await boundCompile(...args);
        };

        // The gated supplier compile of the SAME program — content
        // addressing gives it the same entry identity — into fresh G. G
        // must be a space with no durable closure yet: a warm hit skips
        // the persist entirely and records nothing.
        const gatedCompile = rt2.patternManager.compileOrGetPattern(
          PROGRAM,
          spaceG,
        );
        // Loud construction guard instead of a silent hang: if the compile
        // settles without ever reaching the gate, fail the step. (The
        // loser's derived promise resolves — never rejects — so no
        // unhandled rejection when it settles after losing the race.)
        const gateEngaged = await Promise.race([
          compileStarted.promise.then(() => true),
          gatedCompile.then(() => false, () => false),
        ]);
        if (!gateEngaged) {
          throw new Error("supplier compile settled before the gate engaged");
        }

        const lines = await captureManagerLines(
          async () => {
            // The child replication from a forever-dry origin, issued while
            // the supplier compile is mid-flight. Unfixed, its consult finds
            // origin AND map dry and it one-shot-dies; C parks
            // pattern-unloadable forever (the lunch red).
            rt2.patternManager.replicatePatternToSpace(
              pattern,
              spaceC,
              spaceD,
            );
            await rt2.patternManager.flushCompileCacheWrites();
            await storageManager.synced();
          },
          (entry) => {
            // Release the gate the moment the dry consult announces itself:
            // post-fix via the once-await's own warn (the compile then
            // completes, records G into the fallback map, and the
            // re-consult finds it); pre-fix / await-neutralized via the
            // one-shot failure line, so the step finishes fast and red
            // instead of hanging on the gate.
            if (
              entry.key === "closure-replication-await-inflight" ||
              entry.key === "closure-replication-failed"
            ) {
              compileReleased.resolve();
            }
          },
        );
        await gatedCompile;
        await rt2.patternManager.flushCompileCacheWrites();
        await storageManager.synced();

        // THE PIN: C materialized from the space the in-flight supplier
        // compile persisted into, discovered by the post-await re-consult —
        // and a fresh runtime loads the pattern from C by identity, which
        // is what unparks the demanded roots.
        const target = await readableClosure(rt2, spaceC, entry.identity);
        expect(target.source).toContain(entry.identity);
        const rt3 = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
          experimental: { serverExecution: true },
        });
        try {
          const loaded = await rt3.patternManager.loadPatternByIdentity(
            entry.identity,
            entry.symbol,
            spaceC,
          );
          expect(loaded).toBeDefined();
        } finally {
          await rt3.dispose();
        }

        // The once-await announced itself exactly once, with the in-flight
        // census that discriminates geometry 3 from the register's
        // pre-declared 3b residue (a red with `compilations=0
        // byIdentityLoads=0` on this line is 3b: the supplier compile had
        // not STARTED by consult time).
        const awaited = lines.filter((line) =>
          line.key === "closure-replication-await-inflight"
        );
        expect(awaited.length).toBe(1);
        expect(awaited[0].line).toContain(`entry=${entry.identity}`);
        expect(awaited[0].line).toContain(`from=${spaceD}`);
        expect(awaited[0].line).toContain(`to=${spaceC}`);
        expect(awaited[0].line).toContain("compilations=1");
        expect(awaited[0].line).toContain("byIdentityLoads=0");
        // And the one-shot failure line never fired: the await turned the
        // former one-shot death into a completed replication.
        expect(
          lines.filter((line) => line.key === "closure-replication-failed")
            .length,
        ).toBe(0);
      } finally {
        delete harnessSpy.compileToRecordGraph;
        await rt2.dispose();
      }
    },
  );

  it(
    "a THROWING fallback read is skipped loudly, never loop-aborting — " +
      "the next recorded candidate still rescues the child (the #6484 " +
      "review's F5-1 contract: a store-level error on one candidate " +
      "must not cost the replication its remaining byte-identical " +
      "copies)",
    async () => {
      // R1's compile supplies the pattern OBJECT; rt2 is the manager
      // under test with its own fallback map.
      const pattern = await runtime.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      const entry = runtime.patternManager.getArtifactEntryRef(pattern);
      if (entry === undefined) throw new Error("compile produced no entry ref");
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      const editSpy = rt2 as unknown as {
        edit?: () => ReturnType<Runtime["edit"]>;
      };
      try {
        // Record TWO fallback candidates in rt2's map, in insertion
        // order G then H: the compile persists into G; the content-cache
        // hit for the same program then fires the sibling replication
        // G -> H, whose persist records H.
        await rt2.patternManager.compileOrGetPattern(PROGRAM, spaceG);
        await rt2.patternManager.flushCompileCacheWrites();
        await rt2.patternManager.compileOrGetPattern(PROGRAM, spaceH);
        await rt2.patternManager.flushCompileCacheWrites();
        await storageManager.synced();

        // ARM: every transaction read that addresses G now throws a
        // store-level error (the real shape of a flaky/broken store —
        // NOT a clean miss). D and H reads pass through untouched, so
        // the injection is order-independent: it fires exactly when the
        // fallback loop reads G.
        const realEdit = rt2.edit.bind(rt2);
        let armed = true;
        editSpy.edit = () => {
          const tx = realEdit();
          if (!armed) return tx;
          return new Proxy(tx as object, {
            get(target, prop, receiver) {
              const value = Reflect.get(target, prop, receiver);
              if (typeof value !== "function") return value;
              return (...args: unknown[]) => {
                let mentionsG = false;
                try {
                  mentionsG = JSON.stringify(args)?.includes(spaceG) ?? false;
                } catch {
                  // Unstringifiable args cannot address a space by DID.
                }
                if (armed && mentionsG) {
                  throw new Error(
                    "injected store failure for the armed fallback space",
                  );
                }
                return (value as (...a: unknown[]) => unknown).apply(
                  target,
                  args,
                );
              };
            },
          }) as ReturnType<Runtime["edit"]>;
        };

        const lines = await captureManagerLines(
          async () => {
            // Origin D is dry; the map holds {G, H}; G's read THROWS.
            // Unfixed (a bare `await readOrigin(fallback)`), the store
            // error aborts the whole loop and the child one-shot-dies
            // with H untried; fixed, the loop logs and continues to H.
            rt2.patternManager.replicatePatternToSpace(
              pattern,
              spaceC,
              spaceD,
            );
            await rt2.patternManager.flushCompileCacheWrites();
            await storageManager.synced();
          },
          (entry) => {
            // Disarm once the injected failure has been observed: the
            // loop has moved past G, and the rescue's own writes must
            // hit the real store unimpeded.
            if (entry.key === "closure-replication-fallback-read-failed") {
              armed = false;
            }
          },
        );

        // THE PIN: H rescued the child — the throwing candidate cost
        // one warn, not the replication.
        const target = await readableClosure(rt2, spaceC, entry.identity);
        expect(target.source).toContain(entry.identity);
        const failed = lines.filter((line) =>
          line.key === "closure-replication-fallback-read-failed"
        );
        expect(failed.length).toBe(1);
        expect(failed[0].line).toContain(`fallback=${spaceG}`);
        expect(failed[0].line).toContain(
          "injected store failure for the armed fallback space",
        );
        const rescued = lines.filter((line) =>
          line.key === "closure-replication-fallback-origin"
        );
        expect(rescued.length).toBe(1);
        expect(rescued[0].line).toContain(`fallback=${spaceH}`);
        expect(
          lines.filter((line) => line.key === "closure-replication-failed")
            .length,
        ).toBe(0);
      } finally {
        delete editSpy.edit;
        await rt2.dispose();
      }
    },
  );
});
