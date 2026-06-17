import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("compile-cache-space-aware");
const spaceA = signer.did();
const spaceB = (await Identity.fromPassphrase("compile-cache space B")).did();

// `compileOrGetPattern` (the compileAndRun builtin's compile entry) dedupes the
// expensive TS compile on a content hash that ignores the target space. The
// pattern meta-cell fallback is gone, so a piece persisted in space S reloads in
// a fresh runtime ONLY if S holds the source/compiled closure. When the SAME
// program is compiled into two spaces in one session, the second call is a
// content-cache hit — and before the fix it returned the cached pattern without
// ever writing the closure into the second space, leaving a piece created there
// permanently unloadable ("has no stored source"). The hit now replicates the
// closure into the requested space.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "",
        "export default pattern(() => ({ label: 'hello' }));",
      ].join("\n"),
    },
  ],
};

describe("compileOrGetPattern persists the closure per requested space", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const newRuntime = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  it("a fresh runtime can start a piece created from a cross-space cache hit", async () => {
    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      // Cold compile into space A: writes the closure there, caches by content.
      const patternA = await rt1.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      // Same source, different space: a content-cache HIT. The closure must be
      // replicated into space B so a B-resident piece can reload by identity.
      const patternB = await rt1.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceB,
      );
      // The dedupe returns the same compiled instance (TS compile not repeated).
      expect(patternB).toBe(patternA);

      // Run the pattern with a result cell in space B (the persisted piece).
      const tx1 = rt1.edit();
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        spaceB,
        "compile-cache space-aware piece",
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const r1 = rt1.run(tx1, patternB as any, {}, resultCell1);
      await tx1.commit();
      await r1.pull();
      await rt1.idle();

      const pieceLink = resultCell1.getAsNormalizedFullLink();
      expect(pieceLink.space).toBe(spaceB);

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      // Fresh runtime: load + start the piece from space B. Before the fix this
      // rejects with "has no stored source" because the cache hit never wrote
      // space B's closure.
      const pieceCell = rt2.getCellFromLink(pieceLink);
      await pieceCell.sync();
      const started = await rt2.start(pieceCell);
      expect(started).toBe(true);

      await pieceCell.pull();
      const value = pieceCell.getAsQueryResult() as { label: string };
      expect(value.label).toBe("hello");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
