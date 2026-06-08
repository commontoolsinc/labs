import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getPatternProgram } from "../src/builder/pattern-metadata.ts";
import { ignoreReadForScheduling } from "../src/storage/reactivity-log.ts";

const signer = await Identity.fromPassphrase("load-by-identity-meta-bridge");
const space = signer.did();

// Step 3 — the production trigger: the entry module's content identity is
// learned on the first cold ESM compile and persisted into the pattern's
// metadata (`entryIdentity`). A later `loadPattern` reads it back and passes it
// as `knownEntryIdentity`, so the resolve-free by-identity fast path fires
// instead of resolve + compile. This proves the bridge survives the
// persistence boundary (a fresh runtime on the same storage).
describe("load by identity — pattern-metadata bridge", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const PROGRAM: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      { name: "/util.ts", contents: "export const double = (x:number)=>x*2;" },
      {
        name: "/main.tsx",
        contents: [
          "import { pattern, lift } from 'commonfabric';",
          "import { double } from './util.ts';",
          "const dbl = lift((x:number)=>double(x));",
          "export default pattern<{ value: number }>(({ value }) => {",
          "  return { result: dbl(value) };",
          "});",
        ].join("\n"),
      },
    ],
  };

  const newRuntime = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { esmModuleLoader: true },
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  it("learns entryIdentity on cold load, then fast-paths a later load", async () => {
    // Sessions share one emulated store (the persistence boundary). Earlier
    // runtimes stay alive so their in-flight writes reach the shared store
    // before a later session reads them; everything is disposed at the end.
    const rt1 = newRuntime();
    const rt2 = newRuntime();
    const rt3 = newRuntime();
    try {
      // Session 1: register + persist the pattern's program (no entryIdentity).
      const tx1 = rt1.edit();
      const pm1 = rt1.patternManager;
      const cold = await pm1.compilePattern(PROGRAM, { space, tx: tx1 });
      const patternId = pm1.registerPattern(cold, PROGRAM);
      await tx1.commit();
      await pm1.saveAndSyncPattern({ patternId, space });
      await pm1.flushCompileCacheWrites();
      await rt1.storageManager.synced();
      // The freshly authored meta has no entry identity stored yet.
      expect(pm1.getPatternMeta({ patternId }).entryIdentity).toBeUndefined();

      // Session 2: a fresh runtime loads the pattern from storage. No stored
      // entryIdentity → no by-identity fast path. It compiles (content-warm hit
      // off session 1's compiled cache) and, crucially, learns the entry
      // identity and writes it back into the metadata.
      const pm2 = rt2.patternManager;
      await pm2.loadPattern(patternId, space);
      expect(pm2.getCompileCacheStats().byIdentityHits).toBe(0);
      // Flush the fire-and-forget compiled + metadata write-backs.
      await pm2.flushCompileCacheWrites();
      await rt2.storageManager.synced();
      const learned = pm2.getPatternMeta({ patternId }).entryIdentity;
      expect(typeof learned).toBe("string");
      expect(learned!.length).toBeGreaterThan(0);

      // Session 3: another fresh runtime loads the pattern. The metadata now
      // carries entryIdentity → the by-identity fast path fires (no resolve, no
      // compile): a byIdentity hit.
      const pm3 = rt3.patternManager;
      const loaded = await pm3.loadPattern(patternId, space);
      const stats = pm3.getCompileCacheStats();
      expect(stats.byIdentityHits).toBe(1);
      expect(stats.misses).toBe(0);
      expect(typeof loaded).toBe("function");
    } finally {
      await rt3.dispose();
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("loadPatternByIdentity runs source-free, with no program attached", async () => {
    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      // Populate the compiled cache + learn the entry identity.
      const tx1 = rt1.edit();
      const pm1 = rt1.patternManager;
      const cold = await pm1.compilePattern(PROGRAM, { space, tx: tx1 });
      const entryIdentity = pm1.getArtifactEntryRef(cold)?.identity;
      expect(typeof entryIdentity).toBe("string");
      await tx1.commit();
      await pm1.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      // Fresh runtime loads the pattern by {identity, symbol} alone — no
      // program, no meta cell. It still runs correctly.
      const pm2 = rt2.patternManager;
      const loaded = await pm2.loadPatternByIdentity(
        entryIdentity!,
        "default",
        space,
      );
      expect(typeof loaded).toBe("function");
      expect(pm2.getCompileCacheStats().byIdentityHits).toBe(1);
      // No TypeScript source was pulled: the builder stamps a program stub, but
      // its `files` are empty on the source-free path (vs. the authored set).
      expect(getPatternProgram(loaded!)?.files ?? []).toEqual([]);

      const tx2 = rt2.edit();
      const resultCell = rt2.getCell<{ result: number }>(
        space,
        "by-identity source-free run",
        undefined,
        tx2,
      );
      const result = rt2.run(tx2, loaded!, { value: 7 }, resultCell);
      await tx2.commit();
      await result.pull();
      expect(result.getAsQueryResult()).toEqual({ result: 14 });
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("preserves a non-default export symbol across a source-free reload", async () => {
    // A pattern exported under a NON-default name. The {identity, symbol}
    // reference must keep that symbol — a source-free reload has only a stub
    // program (mainExport "default"), so the symbol must come from the pattern's
    // recorded entry ref, never be recomputed from the program.
    const NAMED: RuntimeProgram = {
      main: "/main.tsx",
      mainExport: "myPattern",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { pattern, lift } from 'commonfabric';",
            "const dbl = lift((x:number)=>x*2);",
            "export const myPattern = pattern<{ value: number }>(",
            "  ({ value }) => ({ result: dbl(value) }),",
            ");",
          ].join("\n"),
        },
      ],
    };

    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      const tx1 = rt1.edit();
      const pm1 = rt1.patternManager;
      const cold = await pm1.compilePattern(NAMED, { space, tx: tx1 });
      // The authored compile records the real export symbol.
      expect(pm1.getArtifactEntryRef(cold)?.symbol).toBe("myPattern");
      const entryIdentity = pm1.getArtifactEntryRef(cold)!.identity;
      await tx1.commit();
      await pm1.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      // Reload by identity with the non-default symbol → still runs, and the
      // reloaded pattern carries the SAME {identity, symbol} ref (not "default").
      const pm2 = rt2.patternManager;
      const reloaded = await pm2.loadPatternByIdentity(
        entryIdentity,
        "myPattern",
        space,
      );
      expect(typeof reloaded).toBe("function");
      expect(pm2.getArtifactEntryRef(reloaded!)).toEqual({
        identity: entryIdentity,
        symbol: "myPattern",
      });

      const tx2 = rt2.edit();
      const resultCell = rt2.getCell<{ result: number }>(
        space,
        "named-export by-identity run",
        undefined,
        tx2,
      );
      const result = rt2.run(tx2, reloaded!, { value: 9 }, resultCell);
      await tx2.commit();
      await result.pull();
      expect(result.getAsQueryResult()).toEqual({ result: 18 });
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("tags an imported sub-pattern with its OWN module identity", async () => {
    // End-to-end guard: a pattern IMPORTED and composed by a parent (never the
    // selected entry of any compile) must still acquire a {identity, symbol}
    // reference, so its composed sub-piece's result cell carries `patternIdentity`
    // meta and the runtime can reload it by identity. The ref is supplied by
    // `registerEvaluatedModules` (which tags every trusted sub-pattern export in
    // the per-load WeakMap, keyed by the exact value) and resolved by
    // `getArtifactEntryRef`'s exact-object-first lookup. This asserts the
    // user-facing invariant — that the sub-piece's recorded identity is the
    // CHILD module's, distinct from the parent's — not any single mechanism.
    const childFile = {
      name: "/child.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern<{ value: number }>(({ value }) => {",
        "  return { echo: value };",
        "});",
      ].join("\n"),
    };
    const PARENT: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        childFile,
        {
          name: "/main.tsx",
          contents: [
            "import { pattern } from 'commonfabric';",
            "import child from './child.tsx';",
            "export default pattern<{ value: number }>(({ value }) => {",
            "  const c = child({ value });",
            "  return { result: c.echo, child: c };",
            "});",
          ].join("\n"),
        },
      ],
    };
    const CHILD_ONLY: RuntimeProgram = {
      main: "/child.tsx",
      files: [childFile],
    };

    const rt = newRuntime();
    try {
      const pm = rt.patternManager;

      // Learn the child module's content identity by compiling it standalone.
      // Same bytes + same resolved imports → same content-addressed identity as
      // the imported sub-module inside PARENT.
      const txc = rt.edit();
      const childStandalone = await pm.compilePattern(CHILD_ONLY, {
        space,
        tx: txc,
      });
      const childRef = pm.getArtifactEntryRef(childStandalone);
      txc.abort?.("child identity learned");
      expect(childRef?.symbol).toBe("default");
      const childIdentity = childRef!.identity;

      // Compile + run the parent that composes the child.
      const tx = rt.edit();
      const parent = await pm.compilePattern(PARENT, { space, tx });
      const parentRef = pm.getArtifactEntryRef(parent);
      expect(parentRef?.identity).toBeTruthy();
      // Distinct per-module identities — the child is not the parent.
      expect(parentRef!.identity).not.toBe(childIdentity);

      const resultCell = rt.getCell<
        { result: number; child: { echo: number } }
      >(
        space,
        "sub-pattern entry-ref run",
        undefined,
        tx,
      );
      const r = rt.run(tx, parent, { value: 5 }, resultCell);
      await tx.commit();
      await r.pull();
      const out = r.getAsQueryResult() as {
        result: number;
        child: { echo: number };
      };
      expect(out.result).toBe(5);
      expect(out.child).toEqual({ echo: 5 });

      // The composed CHILD sub-piece (a non-entry pattern) carries a
      // patternIdentity meta referencing the CHILD module — only possible
      // because the side-table tags every exported pattern, not just the entry.
      const childResultCell = resultCell.key("child").resolveAsCell();
      const meta = childResultCell.getMetaRaw("patternIdentity", {
        meta: ignoreReadForScheduling,
      }) as { identity?: unknown; symbol?: unknown } | undefined;
      expect(meta).toBeTruthy();
      expect(meta?.symbol).toBe("default");
      expect(meta?.identity).toBe(childIdentity);
    } finally {
      await rt.dispose();
    }
  });
});
