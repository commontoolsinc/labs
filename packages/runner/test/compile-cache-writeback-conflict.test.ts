import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import {
  setCompileCacheRuntimeVersionForTesting,
  sourceDocKey,
  WRITE_TARGET_EDGE_SYNC_SCHEMA,
} from "../src/compilation-cache/cell-cache.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("writeback conflict test");
const space = signer.did();

describe("compile-cache write-back after a runtime-version bump", () => {
  it("recovery write-back persists despite pre-existing docs on a cold replica", async () => {
    // CT-1824 regression: a runtime-version bump sends loads through the
    // cold-load recovery path (recompile + write-back). The write-back
    // re-writes version-independent source docs whose cell-layer-derived
    // documents (link/import-edge cells) already exist from the original
    // compile — documents a cold replica has never read. The commit then
    // carries stale seq-0 reads and fails with a ConflictError; before the fix,
    // editWithRetry re-ran immediately against the same stale replica, so every
    // retry failed identically, the compiled cache never healed, and EVERY
    // subsequent cold boot recompiled. The conflict's `readyToRetry` catch-up
    // gate is the designed remedy; editWithRetry must await it like the
    // scheduler does (scheduler/action-run.ts).

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
    const smA = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smA,
    });
    let smB: EmulatedStorageManager | undefined;
    let runtimeB: Runtime | undefined;
    let smC: EmulatedStorageManager | undefined;
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
      smB = EmulatedStorageManager.connectTo(server, { as: signer });
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
      smC = EmulatedStorageManager.connectTo(server, { as: signer });
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

describe("write-back pre-sync materializes edge element docs (CT-1848)", () => {
  it("edge-schema sync delivers element docs to a cold replica; schema-less does not", async () => {
    // CT-1848: the write-target pre-sync carries the one-hop edge selector, so
    // the per-edge element docs (the derived docs the cell layer hoists each
    // `imports[i]` into) are client-known BEFORE the re-write. A schema-less
    // pre-sync normalizes to the rejecting selector and delivers only the root
    // doc; in the browser the re-write then touches the element docs blind and
    // the engine reveals the conflicts one per attempt (the CT-1824 loop,
    // converged only by the retry budget). NOTE: the blind-conflict itself does
    // not reproduce in-process (this fixture's flows warm the element docs some
    // other way — same limitation as the healing test above); the conflict-free
    // attempt-1 property is verified live on the browser rig. What IS pinned
    // here, differentially, is the selector semantics the fix rides on: the
    // edge-schema sync materializes the element docs into a cold replica, the
    // schema-less sync does not.

    const server = newSharedServer();
    const program = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { pattern } from 'commonfabric';",
            "import { double } from './dep.ts';",
            "export default pattern<{ value: number }>(({ value }) => {",
            "  return { result: double(value) };",
            "});",
          ].join("\n"),
        },
        {
          name: "/dep.ts",
          contents: [
            "import { lift } from 'commonfabric';",
            "export const double = lift((x: number) => x * 2);",
          ].join("\n"),
        },
      ],
    };

    const restoreVersion = setCompileCacheRuntimeVersionForTesting(
      "ct1848-version-A",
    );
    const smA = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smA,
    });
    let smB: EmulatedStorageManager | undefined;
    let runtimeB: Runtime | undefined;
    let smC: EmulatedStorageManager | undefined;
    let runtimeC: Runtime | undefined;
    try {
      const txA = runtimeA.edit();
      const compiled = await runtimeA.patternManager.compilePattern(program, {
        space,
        tx: txA,
      });
      const ref = runtimeA.patternManager.getArtifactEntryRef(compiled)!;
      await runtimeA.patternManager.flushCompileCacheWrites();
      await txA.commit();
      await smA.synced();

      // Arm 1 — COLD replica, sync the entry under the one-hop edge schema
      // (what the write-target pre-sync now uses): the element docs arrive.
      smB = EmulatedStorageManager.connectTo(server, { as: signer });
      runtimeB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smB,
      });
      const edgeCell = runtimeB.getCell(
        space,
        sourceDocKey(ref.identity),
        WRITE_TARGET_EDGE_SYNC_SCHEMA,
      );
      await edgeCell.sync();
      const parentUri = edgeCell.getAsNormalizedFullLink().id;
      const providerB = smB.open(space);
      // deno-lint-ignore no-explicit-any
      const rawParent = (providerB as any).get(parentUri);
      expect(rawParent).toBeDefined();
      const importsRaw = rawParent?.value?.imports;
      expect(Array.isArray(importsRaw)).toBe(true);
      expect((importsRaw as unknown[]).length).toBeGreaterThan(0);
      const elementIds: string[] = [];
      for (
        const el of importsRaw as { "/"?: { "link@1"?: { id?: string } } }[]
      ) {
        const id = el?.["/"]?.["link@1"]?.id;
        expect(typeof id).toBe("string");
        elementIds.push(id!);
        // deno-lint-ignore no-explicit-any
        expect((providerB as any).get(id)).toBeDefined();
      }

      // Arm 2 — another COLD replica, schema-less sync (the pre-fix
      // behavior): the root arrives, the element docs do NOT. This is the
      // differential that makes the edge selector load-bearing.
      smC = EmulatedStorageManager.connectTo(server, { as: signer });
      runtimeC = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smC,
      });
      const bareCell = runtimeC.getCell(space, sourceDocKey(ref.identity));
      await bareCell.sync();
      const providerC = smC.open(space);
      // deno-lint-ignore no-explicit-any
      expect((providerC as any).get(parentUri)).toBeDefined();
      for (const id of elementIds) {
        // deno-lint-ignore no-explicit-any
        expect((providerC as any).get(id)).toBeUndefined();
      }
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

describe("editWithRetry conflict catch-up", () => {
  it("awaits readyToRetry between attempts and then succeeds", async () => {
    // Direct contract test for the fix: a conflict's `readyToRetry` catch-up
    // gate must be awaited BEFORE the retry re-runs, and the retry then
    // succeeds.

    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
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

describe("editWithRetry sequential conflict discovery", () => {
  // The browser cold-boot shape of CT-1824 (live-traced on the rig): the
  // write-back's derived docs are discovered ONE per attempt — the engine
  // rejects on the first stale read, the retry pulls exactly that doc, and
  // only then does the next attempt's diff reach the following one.
  // editWithRetry must (a) pull the doc each conflict names so each round
  // makes progress, and (b) survive a pull or catch-up failure without giving
  // up the round (the retry's commit is the definitive outcome). Convergence
  // takes one round per pre-existing derived doc, which is why
  // `#writeBackCompileCache` passes a budget sized to its write set instead of
  // DEFAULT_MAX_RETRIES.

  it("pulls each named doc and converges one doc per round", async () => {
    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const CONFLICTS = 8;
    const pulls: string[] = [];
    const provider = sm.open(space);
    // deno-lint-ignore no-explicit-any
    (provider as any).sync = (uri: string) => {
      pulls.push(uri);
      // Round 3's pull fails; the round must still proceed to its retry.
      if (uri === "of:doc-3") {
        return Promise.reject(new Error("pull failed"));
      }
      return Promise.resolve({ ok: {} });
    };
    let commits = 0;
    const fakeTx = () => ({
      tx: {},
      abort: () => {},
      commit: () => {
        commits++;
        if (commits <= CONFLICTS) {
          const k = commits;
          return Promise.resolve({
            error: {
              name: "ConflictError",
              message:
                `stale confirmed read: of:doc-${k} at seq 0 conflicted with seq ${
                  10 + k
                }`,
              // Round 5's catch-up gate rejects (session churn); the retry
              // must run anyway.
              readyToRetry: () =>
                k === 5
                  ? Promise.reject(new Error("session replaced"))
                  : Promise.resolve(),
              conflict: {
                space,
                the: "application/json",
                of: `of:doc-${k}`,
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
      const result = await runtime.editWithRetry(() => {}, 64);
      expect(result.error).toBeUndefined();
      // One commit per conflict round plus the converging attempt.
      expect(commits).toBe(CONFLICTS + 1);
      // Every round pulled exactly the doc its conflict named, in order.
      expect(pulls).toEqual(
        Array.from({ length: CONFLICTS }, (_, i) => `of:doc-${i + 1}`),
      );
    } finally {
      await runtime.dispose();
      await sm.close();
      await server.close();
    }
  });

  it("exhausts the default budget when discovery outlasts it", async () => {
    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const provider = sm.open(space);
    // deno-lint-ignore no-explicit-any
    (provider as any).sync = () => Promise.resolve({ ok: {} });
    let commits = 0;
    const fakeTx = () => ({
      tx: {},
      abort: () => {},
      commit: () => {
        commits++;
        return Promise.resolve({
          error: {
            name: "ConflictError",
            message: `stale confirmed read: of:doc-${commits} at seq 0 ` +
              `conflicted with seq ${10 + commits}`,
            readyToRetry: () => Promise.resolve(),
            conflict: {
              space,
              the: "application/json",
              of: `of:doc-${commits}`,
            },
          },
        });
      },
    });
    // deno-lint-ignore no-explicit-any
    (runtime as any).edit = () => fakeTx();
    // deno-lint-ignore no-explicit-any
    (runtime as any).prepareTxForCommit = () => {};
    try {
      // With the general default (5 retries = 6 attempts), a write set with
      // more never-read derived docs than that cannot converge — the CT-1824
      // cold-boot loop. This is the behavior `#writeBackCompileCache`'s larger
      // budget exists to clear.
      const result = await runtime.editWithRetry(() => {});
      expect(result.error).toBeDefined();
      expect(commits).toBe(6);
    } finally {
      await runtime.dispose();
      await sm.close();
      await server.close();
    }
  });
});
