import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";

import { EmulatedStorageManager } from "../src/storage/cache.deno.ts";
import { newLoopbackServer } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
  resolveEntryIdentity,
} from "../src/index.ts";
import {
  brandTrustedPattern,
  noteDerivedCopy,
  setPatternSourcePath,
} from "../src/builder/pattern-metadata.ts";

/**
 * L3(a), RULED 2026-08-27 (owner): session-synthetic `keyless:` identities
 * must NEVER land in durable state — pattern-manager.ts's own contract
 * ("such refs must never be written into durable state"). The keyless
 * population is runtime-built pattern VALUES whose producing code is
 * module-addressed (the transformer hoists all source-authored
 * lift()/handler() code to cf:module — CT-1644/CT-1655), so nothing keyless
 * should ever need loading: reactive producers re-derive on demand.
 *
 * The 2026-08-27 diagnosis (docs/history/plans/server-execution-v2/optimize/
 * keyless-diagnosis-2026-08-27.md) found the contract violated by every
 * writer that touches a minted pattern:
 *   1. `Runner.setup()`'s durable `patternIdentity`/`patternSetupIdentity`
 *      stamps (`if (entryRef)` filters nothing — `entryRefForPattern`
 *      always mints);
 *   2. `Runner.substituteOpPatternRefs`' `$patternRef` sentinel for keyless
 *      map/filter/flatMap ops (written into the node's durable inputs doc);
 *   3. the storage-boundary serializer itself (`patternToEncodableForm`):
 *      the mint sets the pattern's forward entry ref, so the designed
 *      "no entry ref -> full graph" fallback stops firing and every later
 *      boundary write of the VALUE emits the keyless ref.
 *
 * The first test is the blanket pin: a run exercising all three writers must
 * leave NO `keyless:` byte sequence anywhere in the raw sqlite store. The
 * second pins the CT-1923 roll-forward extension: with the running ref
 * keyless, the repair converges the durable pointer to the running pattern's
 * module-addressed PRODUCER (the first real entry ref up the derivation
 * chain / late-indexed identity) instead of refusing.
 */

const signer = await Identity.fromPassphrase("keyless-never-durable");
const space = signer.did();

// A minimal map-over-pattern program. Bare-evaluated (non-registering), its
// op pattern carries no content-addressed entry ref, so node instantiation
// mints the op's `keyless:` session identity (the CT-1812 keyless-op path).
const MAP_PROGRAM_SOURCE = `
import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

interface ItemIn {
  n: number;
}
interface ItemOut {
  [NAME]: string;
  [UI]: VNode;
  doubled: number;
}

const Item = pattern<ItemIn, ItemOut>(({ n }) => {
  return {
    [NAME]: "item",
    [UI]: <div>{n}</div>,
    doubled: n,
  };
});

export const itemOp = Item;

export default pattern(() => {
  const items = new Writable<number[]>([1, 2, 3]);
  const ui = <div>{items.map((n) => <Item n={n} />)}</div>;
  return {
    [NAME]: "keyless-map-root",
    [UI]: ui,
  };
});
`;

const mapProgram: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: MAP_PROGRAM_SOURCE }],
};

// The swap-test shape: a hand-built pattern object that never saw a compile.
const handBuiltPattern = () => ({
  argumentSchema: {},
  resultSchema: {
    type: "object",
    properties: { marker: { type: "string" } },
  },
  result: { marker: "hand-built" },
  nodes: [],
});

// A well-formed content identity whose source closure is persisted nowhere —
// the unloadable-vintage stand-in (same construction as
// pattern-pointer-unloadable-swap.test.ts).
const UNLOADABLE_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { marker: string }>(() => {",
  "  return { marker: 'unloadable-vintage' };",
  "});",
  "",
].join("\n");

const unloadableIdentityPromise = resolveEntryIdentity(
  "/main.tsx",
  (name) =>
    name === "/main.tsx"
      ? Promise.resolve(UNLOADABLE_SOURCE)
      : Promise.reject(new Error(`not found: ${name}`)),
);

/** Every occurrence of `needle` across all files under `dir`, with context. */
const scanDirForBytes = async (
  dir: string,
  needle: string,
): Promise<string[]> => {
  const hits: string[] = [];
  const needleBytes = new TextEncoder().encode(needle);
  const scanFile = async (path: string) => {
    const bytes = await Deno.readFile(path);
    for (let i = 0; i + needleBytes.length <= bytes.length; i++) {
      if (bytes[i] !== needleBytes[0]) continue;
      let match = true;
      for (let j = 1; j < needleBytes.length; j++) {
        if (bytes[i + j] !== needleBytes[j]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      const start = Math.max(0, i - 40);
      const end = Math.min(bytes.length, i + needleBytes.length + 80);
      const context = new TextDecoder("utf-8", { fatal: false })
        .decode(bytes.slice(start, end))
        .replace(/[^\x20-\x7e]/g, ".");
      hits.push(`${path} @${i}: …${context}…`);
    }
  };
  const walk = async (current: string) => {
    for await (const entry of Deno.readDir(current)) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.isFile) await scanFile(path);
    }
  };
  await walk(dir);
  return hits;
};

describe("keyless identities never land durably (L3(a), RULED 2026-08-27)", () => {
  let runtime: Runtime | undefined;
  let storageManager: EmulatedStorageManager | undefined;

  afterEach(async () => {
    await runtime?.runner.idlePointerMaintenance();
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("leaves no `keyless:` bytes in the raw store across all three writer paths", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "keyless-never-durable-",
    });
    const store = toFileUrl(`${directory}/`);
    const server = newLoopbackServer({
      subscriptionRefreshDelayMs: 0,
      store,
    });
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    // The SESSION-side instantiation report must keep flowing even though
    // the durable stamp is skipped: cf-harness's stranded-piece guard
    // (`run_pattern` via `keylessSince`) exists to see exactly this
    // evidence, and coupling the observer to the durable write makes it
    // fail open. Collected here so the same test that proves the store
    // stays clean proves the report still happens.
    const reportedIdentities: string[] = [];
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      onPatternInstantiated: (instantiation) =>
        reportedIdentities.push(instantiation.identity),
    });
    try {
      // Writer 1: Runner.setup's durable pattern-pointer stamps for a
      // hand-built (keyless) root pattern.
      {
        const tx = runtime.edit();
        const cell = runtime.getCell<Record<string, unknown>>(
          space,
          "keyless-writer-1-root",
          undefined,
          tx,
        );
        // deno-lint-ignore no-explicit-any
        const running = runtime.run(tx, handBuiltPattern() as any, {}, cell);
        await tx.commit();
        await running.pull();
        expect(
          reportedIdentities.some((identity) =>
            identity.startsWith("keyless:")
          ),
        ).toBe(true);
      }

      // Writer 2: the map builtin's `$patternRef` sentinel for a keyless op
      // (bare evaluation indexes nothing, so the op pattern has no ref).
      const engine = runtime.harness as Engine;
      const evalResult = await engine.compileAndEvaluateModules(mapProgram);
      const factory = evalResult.main!.default as Parameters<
        Runtime["run"]
      >[1];
      {
        const tx = runtime.edit();
        const cell = runtime.getCell<Record<string, unknown>>(
          space,
          "keyless-writer-2-map",
          undefined,
          tx,
        );
        const running = runtime.run(tx, factory, {}, cell);
        runtime.prepareTxForCommit(tx);
        await tx.commit();
        const cancel = running.sink(() => {});
        await runtime.idle();
        cancel();
      }

      // Writer 3: the storage boundary itself. The root factory was minted a
      // keyless ref by the run above; writing it as a plain VALUE must fall
      // back to the full-graph serialization, not emit the minted ref.
      {
        const tx = runtime.edit();
        const cell = runtime.getCell<Record<string, unknown>>(
          space,
          "keyless-writer-3-value",
          undefined,
          tx,
        );
        cell.withTx(tx).set({ captured: factory });
        await tx.commit();
      }
      // Same boundary, asserted directly: `toJSON` reaches
      // patternToEncodableForm; a minted (keyless) ref must not surface.
      expect(JSON.stringify(factory)).not.toContain("keyless:");

      await runtime.idle();
      await runtime.storageManager.synced();
    } finally {
      await runtime.runner.idlePointerMaintenance();
      await runtime.dispose();
      runtime = undefined;
      await storageManager.close();
      storageManager = undefined;
      await server.close();
    }

    try {
      const hits = await scanDirForBytes(directory, "keyless:");
      expect(hits).toEqual([]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("converges an unloadable pointer to the running keyless pattern's producer identity", async () => {
    // The late-indexing window: a pattern evaluated bare (keyless) starts a
    // piece; its module is indexed AFTERWARDS (the production shape where a
    // bundle registers after build-time copies/uses). With the durable
    // pointer then repointed to a definitively unloadable identity, the
    // CT-1923 roll-forward used to REFUSE (running ref keyless -> nothing
    // durable to write). Ruled 2026-08-27: converge to the producer — the
    // first module-addressed (non-keyless) entry ref reachable from the
    // running pattern value.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const engine = runtime.harness as Engine;
    const evalResult = await engine.compileAndEvaluateModules(mapProgram);
    const factory = evalResult.main!.default as Parameters<Runtime["run"]>[1];
    // Bare evaluation indexed nothing: keyless going in.
    expect(runtime.patternManager.getArtifactEntryRef(factory as object))
      .toBeUndefined();

    const tx = runtime.edit();
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "keyless-producer-converge",
      undefined,
      tx,
    );
    const running = runtime.run(tx, factory, {}, cell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    const cancel = running.sink(() => {});
    await runtime.idle();

    // The module registers AFTER the piece started: the pattern's structure
    // is now addressable under its real content identity.
    runtime.patternManager.registerEvaluatedModules(evalResult);
    const realRef = runtime.patternManager.getArtifactEntryRef(
      factory as object,
    );
    expect(realRef).toBeDefined();
    expect(realRef!.identity).not.toMatch(/^keyless:/);

    // Repoint the durable pointer at a definitively unloadable identity.
    const unloadableIdentity = await unloadableIdentityPromise;
    {
      const repointTx = runtime.edit();
      cell.withTx(repointTx).setMetaRaw("patternIdentity", {
        identity: unloadableIdentity,
        symbol: "default",
      });
      await repointTx.commit();
    }
    await runtime.idle();
    await runtime.runner.idlePointerMaintenance();
    await runtime.idle();
    await runtime.runner.idlePointerMaintenance();

    // Converged to the producer's real identity — not left unloadable, and
    // never a `keyless:` write.
    const healed = getPatternIdentityRef(cell);
    expect(healed?.identity).toBe(realRef!.identity);
    cancel();
    await runtime.idle();
  });

  it("heals a legacy durable keyless pointer over a running real pattern", async () => {
    // Pre-guard stores carry durable `keyless:` pattern pointers (today's
    // leaked orphans). Read back while a REAL pattern runs, such a pointer is
    // definitively unloadable in every session and every CFC mode — the
    // watcher tolerates it (debug record, no load probe) and, with the heal
    // family on, rolls the pointer forward to the running identity.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const compiled = await runtime.patternManager.compilePattern(mapProgram, {
      space,
      tx,
    });
    const realRef = runtime.patternManager.getArtifactEntryRef(
      compiled as object,
    )!;
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "legacy-keyless-pointer-heal",
      undefined,
      tx,
    );
    const running = runtime.run(
      tx,
      compiled as Parameters<Runtime["run"]>[1],
      {},
      cell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    const cancel = running.sink(() => {});
    await runtime.idle();
    expect(getPatternIdentityRef(cell)?.identity).toBe(realRef.identity);

    // The legacy orphan: a durable keyless pointer from a pre-guard session
    // (never minted here, so the in-memory index cannot serve it either).
    {
      const repointTx = runtime.edit();
      cell.withTx(repointTx).setMetaRaw("patternIdentity", {
        identity: "keyless:fid1:legacy-orphan-from-a-pre-guard-session",
        symbol: "default",
      });
      await repointTx.commit();
    }
    await runtime.idle();
    await runtime.runner.idlePointerMaintenance();
    await runtime.idle();
    await runtime.runner.idlePointerMaintenance();

    expect(getPatternIdentityRef(cell)?.identity).toBe(realRef.identity);
    cancel();
    await runtime.idle();
  });

  it("tolerates a legacy keyless pointer in the start walk: not started, not rejected", async () => {
    // The boot-walk face of the same legacy state: starting a piece whose
    // durable pointer is a pre-guard keyless orphan must not fail the walk
    // with a load rejection — the pointer is unloadable by construction, the
    // piece is reported as not started (the tolerated orphan), and the debug
    // record says why.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "legacy-keyless-pointer-start",
      undefined,
      tx,
    );
    cell.withTx(tx).set({ marker: "orphan" });
    cell.withTx(tx).setMetaRaw("patternIdentity", {
      identity: "keyless:fid1:legacy-orphan-from-a-pre-guard-session",
      symbol: "default",
    });
    await tx.commit();
    await runtime.idle();

    const started = await runtime.runner.start(cell);
    expect(started).toBe(false);
  });

  it("a derived copy sheds its pre-registration keyless shadow once the root promotes", async () => {
    // The late-indexing window crossed with a build-time copy: a copy made
    // while the root's only ref was the session mint must not pin that
    // keyless ref (getArtifactEntryRef consults the exact object first, so
    // a pinned copy would shadow the root's later REAL promotion forever —
    // leaving the copy's pieces pointer-less and its boundary form embedded
    // in a fresh runtime).
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const engine = runtime.harness as Engine;
    const evalResult = await engine.compileAndEvaluateModules(mapProgram);
    const factory = evalResult.main!.default as object;

    // Mint the session identity on the (still unregistered) root, then make
    // a derivation copy while the root is keyless.
    const minted = runtime.patternManager.ensureKeylessPatternIdentity(
      factory as never,
    );
    expect(minted.identity).toMatch(/^keyless:/);
    const copy = { derivedCopyOf: "map-root" };
    noteDerivedCopy(copy, factory);

    // The module registers: the root's ref promotes to its real identity.
    runtime.patternManager.registerEvaluatedModules(evalResult);
    const rootRef = runtime.patternManager.getArtifactEntryRef(factory);
    expect(rootRef).toBeDefined();
    expect(rootRef!.identity).not.toMatch(/^keyless:/);

    // The copy resolves through the root and sees the REAL identity.
    const copyRef = runtime.patternManager.getArtifactEntryRef(copy);
    expect(copyRef?.identity).toBe(rootRef!.identity);
  });

  it("a keyed piece re-setup with a keyless pattern sheds its stale durable pointer", async () => {
    // The reverse handoff: a piece that once carried a REAL durable pointer
    // is re-setup with a hand-built (keyless) pattern. The keyless setup
    // stamps nothing — so it must CLEAR the stale pointer and setup marker,
    // or later starts (fresh sessions especially) would select the old
    // pattern over the state setup just staged.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const compiled = await runtime.patternManager.compilePattern(mapProgram, {
      space,
      tx,
    });
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "keyed-to-keyless-supersede",
      undefined,
      tx,
    );
    const running = runtime.run(
      tx,
      compiled as Parameters<Runtime["run"]>[1],
      {},
      cell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    const cancel = running.sink(() => {});
    await runtime.idle();
    expect(getPatternIdentityRef(cell)).toBeDefined();
    cancel();
    runtime.runner.stop(cell);

    const tx2 = runtime.edit();
    // deno-lint-ignore no-explicit-any
    const rerun = runtime.run(tx2, handBuiltPattern() as any, {}, cell);
    await tx2.commit();
    await rerun.pull();

    expect(getPatternIdentityRef(cell)).toBeUndefined();
    expect(getPatternSetupIdentityRef(cell)).toBeUndefined();
  });

  it("a fresh session replays a keyless piece's setup without restaging its stored argument", async () => {
    // The cross-session `cf get` transform shape: session A sets up a
    // keyless piece over a deterministic doc; session B (fresh runtime, no
    // durable pointer, no setup marker — the keyless piece's designed
    // durable verdict) re-runs the structurally same pattern on the same
    // doc. Zero evidence of any update exists, so setup must NOT restage —
    // restaging validates the stored argument against the candidate schema
    // and rewrites defaults, and the transform replay failed exactly there
    // ("additional property"). The pattern's schema rejects extras; the
    // stored argument carries one (written un-validated by A's plain
    // new-cell path, as materialized link reads do in production).
    const directory = await Deno.makeTempDir({ prefix: "keyless-replay-" });
    const store = toFileUrl(`${directory}/`);
    const server = newLoopbackServer({
      subscriptionRefreshDelayMs: 0,
      store,
    });
    const strictPattern = () => ({
      argumentSchema: {
        type: "object",
        properties: { v: { type: "number" } },
        additionalProperties: false,
      },
      resultSchema: {
        type: "object",
        properties: { out: { type: "number" } },
      },
      result: { out: { $alias: { cell: "argument", path: ["v"] } } },
      nodes: [],
    });
    try {
      const managerA = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const runtimeA = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: managerA,
      });
      try {
        const tx = runtimeA.edit();
        const cell = runtimeA.getCell<Record<string, unknown>>(
          space,
          "keyless-cross-session-replay",
          undefined,
          tx,
        );
        const running = runtimeA.run(
          tx,
          // deno-lint-ignore no-explicit-any
          strictPattern() as any,
          { v: 1, extra: 2 },
          cell,
        );
        await tx.commit();
        await running.pull();
        await runtimeA.storageManager.synced();
      } finally {
        await runtimeA.runner.idlePointerMaintenance();
        await runtimeA.dispose();
        await managerA.close();
      }

      storageManager = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const tx2 = runtime.edit();
      const cell2 = runtime.getCell<Record<string, unknown>>(
        space,
        "keyless-cross-session-replay",
        undefined,
        tx2,
      );
      await cell2.sync();
      const rerun = runtime.run(
        tx2,
        // deno-lint-ignore no-explicit-any
        strictPattern() as any,
        { v: 1, extra: 2 },
        cell2,
      );
      const committed = await tx2.commit();
      expect(committed.error).toBeUndefined();
      const value = await rerun.pull();
      expect((value as { out?: number })?.out).toBe(1);
    } finally {
      await server.close();
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("a failed keyless re-setup restores the prior session pointer", async () => {
    // The durable stamp was transactional: keyless P1's stamp survived a
    // LATER setup's failed transaction untouched. The session pointer that
    // replaced it is set eagerly at staging (mirroring
    // `locallyPreparedResults`), so the failure cleanup must RESTORE the
    // prior committed pointer — deleting it would leave the still-running
    // P1 piece pointer-less: start-by-pointer dead, marker absent (the
    // evicted/zero-evidence shape) — a piece this session owns turning
    // unresolvable because someone ELSE's setup failed.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "failed-resetup-restores-pointer",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const running = runtime.run(tx, handBuiltPattern() as any, {}, cell);
    await tx.commit();
    await running.pull();
    const first = runtime.runner.sessionPatternPointerFor(cell);
    expect(first).toBeDefined();
    runtime.runner.stop(cell);

    // A structurally DIFFERENT keyless pattern staged over it; the staging
    // transaction dies before commit.
    const differentPattern = {
      ...handBuiltPattern(),
      result: { marker: "hand-built-v2" },
    };
    const tx2 = runtime.edit();
    // deno-lint-ignore no-explicit-any
    runtime.run(tx2, differentPattern as any, {}, cell);
    expect(runtime.runner.sessionPatternPointerFor(cell)?.identity)
      .not.toBe(first!.identity);
    tx2.abort();

    expect(runtime.runner.sessionPatternPointerFor(cell)?.identity).toBe(
      first!.identity,
    );
  });

  it("a failed REAL re-setup keeps the keyless session pointer; a committed one sheds it", async () => {
    // The other half of the same transactional semantics: a real pattern's
    // setup deletes the session pointer because its durable stamps
    // supersede it — but the stamps are staged IN the transaction, so the
    // delete must land with the commit, not at staging. A failed real
    // re-setup used to drop the pointer while its stamps rolled back,
    // leaving the keyless piece with neither.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const setupTx = runtime.edit();
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export default pattern<Record<string, never>, { marker: string }>(",
          "  () => ({ marker: 'real-resetup' }),",
          ");",
          "",
        ].join("\n"),
      }],
    }, {
      space,
      tx: setupTx,
    });
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "failed-real-resetup-keeps-pointer",
      undefined,
      setupTx,
    );
    // deno-lint-ignore no-explicit-any
    const running = runtime.run(setupTx, handBuiltPattern() as any, {}, cell);
    await setupTx.commit();
    await running.pull();
    const first = runtime.runner.sessionPatternPointerFor(cell);
    expect(first).toBeDefined();
    runtime.runner.stop(cell);

    // Real re-setup whose transaction dies: stamps roll back, pointer stays.
    const tx2 = runtime.edit();
    runtime.run(tx2, compiled as Parameters<Runtime["run"]>[1], {}, cell);
    tx2.abort();
    expect(getPatternIdentityRef(cell)).toBeUndefined();
    expect(runtime.runner.sessionPatternPointerFor(cell)?.identity).toBe(
      first!.identity,
    );

    // The same re-setup COMMITTED: durable stamps land, pointer sheds.
    const tx3 = runtime.edit();
    const rerun = runtime.run(
      tx3,
      compiled as Parameters<Runtime["run"]>[1],
      {},
      cell,
    );
    await tx3.commit();
    await rerun.pull();
    expect(getPatternIdentityRef(cell)).toBeDefined();
    expect(runtime.runner.sessionPatternPointerFor(cell)).toBeUndefined();
    runtime.runner.stop(cell);
  });

  it("an evicted session pointer does not masquerade as the zero-evidence state", async () => {
    // The session pointer map is BOUNDED: past its capacity a long-lived
    // session (a server streaming keyless `cf get` transforms) evicts its
    // oldest entries. An evicted piece then reads pointer-absent AND
    // marker-absent — byte-identical to the DESIGNED zero-evidence state (a
    // fresh session replaying a keyless piece) — so a DIFFERENT keyless
    // pattern staged over it with no supplied argument would skip exactly
    // the restage validation the un-evicted state performed, reading stale
    // argument bytes through the new schema unvalidated. Eviction is
    // "evidence unknown", not "no evidence": the eviction tombstone forces
    // the conservative restage, whose validation rejects the stored
    // argument the new pattern cannot read — loudly.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Accepts extras…
    const loosePattern = () => ({
      argumentSchema: { type: "object" },
      resultSchema: {
        type: "object",
        properties: { out: { type: "number" } },
      },
      result: { out: { $alias: { cell: "argument", path: ["v"] } } },
      nodes: [],
    });
    // …the re-setup pattern does not.
    const strictPattern = () => ({
      argumentSchema: {
        type: "object",
        properties: { v: { type: "number" } },
        additionalProperties: false,
      },
      resultSchema: {
        type: "object",
        properties: { out: { type: "number" } },
      },
      result: { out: { $alias: { cell: "argument", path: ["v"] } } },
      nodes: [],
    });

    const tx = runtime.edit();
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "evicted-pointer-not-zero-evidence",
      undefined,
      tx,
    );
    const running = runtime.run(
      tx,
      // deno-lint-ignore no-explicit-any
      loosePattern() as any,
      { v: 1, extra: 2 },
      cell,
    );
    await tx.commit();
    await running.pull();
    expect(runtime.runner.sessionPatternPointerFor(cell)).toBeDefined();
    runtime.runner.stop(cell);

    // Capacity-evict the piece's pointer with synthetic churn — the map's
    // REAL eviction path, just fed faster than a server would.
    const pointers = (runtime.runner as unknown as {
      sessionPatternPointers: {
        set(key: string, value: { identity: string; symbol: string }): void;
      };
    }).sessionPatternPointers;
    for (
      let i = 0;
      runtime.runner.sessionPatternPointerFor(cell) !== undefined;
      i++
    ) {
      if (i > 100_000) throw new Error("the pointer never evicted");
      pointers.set(`synthetic/${i}`, {
        identity: `keyless:churn-${i}`,
        symbol: "default",
      });
    }

    // The different-pattern re-setup with NO supplied argument: the restage
    // decision is the only validation gate left, and it must fire.
    const tx2 = runtime.edit();
    let loud = false;
    try {
      const rerun = runtime.run(
        tx2,
        // deno-lint-ignore no-explicit-any
        strictPattern() as any,
        undefined,
        cell,
      );
      const committed = await tx2.commit();
      if (committed.error !== undefined) loud = true;
      else await rerun.pull();
    } catch {
      loud = true;
    }
    expect(loud).toBe(true);
  });

  it("counts a keyless mint against a module-indexed pattern (missing-association tripwire)", async () => {
    // The sanctioned keyless population is runtime-BUILT values. A pattern
    // carrying a module-index source path reaching the mint means its
    // content-addressed association went missing — the tripwire counts it.
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    // A plain hand-built pattern mints silently: anomaly count stays 0.
    {
      const tx = runtime.edit();
      const cell = runtime.getCell<Record<string, unknown>>(
        space,
        "mint-tripwire-clean",
        undefined,
        tx,
      );
      // deno-lint-ignore no-explicit-any
      const running = runtime.run(tx, handBuiltPattern() as any, {}, cell);
      await tx.commit();
      await running.pull();
      expect(runtime.patternManager.keylessMintAnomalies).toBe(0);
    }

    // The anomaly shape: a "module-indexed" pattern (source path stamped by
    // the indexing loop — always on a branded artifact) that somehow lost
    // its entry-ref association.
    {
      const anomalous = brandTrustedPattern(handBuiltPattern());
      setPatternSourcePath(anomalous, "/tripwire.tsx");
      const tx = runtime.edit();
      const cell = runtime.getCell<Record<string, unknown>>(
        space,
        "mint-tripwire-anomalous",
        undefined,
        tx,
      );
      // deno-lint-ignore no-explicit-any
      const running = runtime.run(tx, anomalous as any, {}, cell);
      await tx.commit();
      await running.pull();
      expect(runtime.patternManager.keylessMintAnomalies).toBe(1);
    }
  });
});
