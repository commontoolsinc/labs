/**
 * T7 (CT-1838, appendix Layer 1 test plan): end-to-end PIECE layer over a
 * space whose DEFAULT PATTERN is stored in the pre-#4158 legacy-envelope
 * form. This is the exact field failure: the space's piece registry
 * (`allPieces`) and `addPiece` live INSIDE the default-pattern piece, so a
 * default pattern that cannot cold-load bricks `getPieces` (detached
 * "empty-pieces" placeholder) and every `cf piece new`.
 *
 * The fixture simulates the pre-#4158 writer (stored source = helper-
 * INJECTED bytes, identities over the injected bytes, no compiled set for
 * the session under test), and the second session runs under a BUMPED
 * compile-cache runtimeVersion — the pin-bump scenario that surfaced
 * CT-1838 in production: the compiled set misses, and only the legacy
 * source docs remain to cold-load from.
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { injectCfHelpers } from "@commonfabric/ts-transformers";
import type { Engine } from "../../runner/src/harness/engine.ts";
import type {
  CacheableModule,
  RuntimeProgram,
} from "../../runner/src/harness/types.ts";
import { computeModuleHashes } from "../../runner/src/harness/module-identity.ts";
import {
  setCompileCacheRuntimeVersionForTesting,
  writeSourceDocs,
} from "../../runner/src/compilation-cache/cell-cache.ts";
import { pieceId, PieceManager } from "../src/manager.ts";

const signer = await Identity.fromPassphrase(
  "legacy envelope default pattern",
);

// A minimal transformed default pattern with the real default-app's export
// surface for the piece registry: `allPieces` plus the `addPiece` handler
// stream `PieceManager.add` sends into.
const defaultPatternProgram: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { handler, pattern, Writable } from 'commonfabric';",
        "type Piece = { title?: string };",
        "const addPiece = handler<",
        "  { piece: Piece },",
        "  { allPieces: Writable<Piece[]> }",
        ">((event, { allPieces }) => {",
        "  const piece = event?.piece;",
        "  if (!piece) return;",
        "  allPieces.push(piece);",
        "});",
        "export default pattern<{ allPieces: Piece[] }>(({ allPieces }) => ({",
        "  allPieces,",
        "  addPiece: addPiece({ allPieces }),",
        "}));",
      ].join("\n"),
    },
  ],
};

const simplePieceProgram: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern<{ value: number }>(({ value }) => ({ value }));",
      ].join("\n"),
    },
  ],
};

// Simulate the PRE-#4158 writer: stored source = the INJECTED bytes,
// identities computed over the injected bytes (same recipe as the runner's
// load-by-identity tolerance tests, byte-calibrated against the real
// production dump in packages/ts-transformers/test/core/legacy-envelope
// .test.ts).
async function buildLegacyClosure(
  engine: Engine,
  program: RuntimeProgram,
): Promise<{ modules: CacheableModule[]; entryIdentity: string }> {
  const authored = await engine.compileToRecordGraph(program);
  const entryFilename = authored.modules
    .find((m) => m.identity === authored.entryIdentity)!.filename;
  const injectedByFilename = new Map(
    authored.modules.map((m) =>
      [m.filename, injectCfHelpers(m.source, m.filename)] as const
    ),
  );
  const legacyHashes = computeModuleHashes({
    main: entryFilename,
    files: [...injectedByFilename].map(([name, contents]) => ({
      name,
      contents,
    })),
  });
  const legacyByAuthored = new Map(
    authored.modules.map(
      (m) => [m.identity, legacyHashes.get(m.filename)!] as const,
    ),
  );
  const modules: CacheableModule[] = authored.modules.map((m) => ({
    identity: legacyHashes.get(m.filename)!,
    filename: m.filename,
    source: injectedByFilename.get(m.filename)!,
    js: "",
    imports: m.imports.map((i) => ({
      specifier: i.specifier,
      targetIdentity: legacyByAuthored.get(i.targetIdentity) ??
        i.targetIdentity,
    })),
  }));
  return {
    modules,
    entryIdentity: legacyByAuthored.get(authored.entryIdentity)!,
  };
}

describe("piece layer over a legacy-envelope default pattern (CT-1838)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  const runtimes: Runtime[] = [];

  const newRuntime = () => {
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtimes.push(rt);
    return rt;
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    for (const rt of runtimes.splice(0)) {
      try {
        await rt.patternManager.flushCompileCacheWrites();
      } catch {
        // Dispose regardless.
      }
      await rt.dispose();
    }
    await storageManager?.close();
  });

  it("T7: getPieces returns the registry and add succeeds after a pin bump", async () => {
    const spaceName = "legacy-envelope-default-" + crypto.randomUUID();

    // --- Session 1: build the poisoned space. ---
    const runtime1 = newRuntime();
    const session1 = await createSession({ identity: signer, spaceName });
    const manager1 = new PieceManager(session1, runtime1);
    await manager1.synced();
    const space = manager1.getSpace();

    // Persist the default pattern in LEGACY form (injected bytes, injected
    // identities — what a pre-#4158 pipeline stored).
    const legacy = await buildLegacyClosure(
      runtime1.harness as Engine,
      defaultPatternProgram,
    );
    const writeTx = runtime1.edit();
    writeSourceDocs(
      runtime1,
      space,
      legacy.modules,
      legacy.entryIdentity,
      writeTx,
    );
    runtime1.prepareTxForCommit(writeTx);
    expect((await writeTx.commit()).error).toBeUndefined();

    // Cold-load it (heals via tolerance) — the loaded pattern carries the
    // LEGACY `{identity, symbol}` ref, so the piece created from it points
    // at the legacy identity, exactly like a pre-#4158 default piece.
    const healed = await runtime1.patternManager.loadPatternByIdentity(
      legacy.entryIdentity,
      "default",
      space,
    );
    expect(typeof healed).toBe("function");
    const defaultPiece = await manager1.runPersistent(
      healed!,
      { allPieces: [] },
      "legacy-default-pattern-piece",
    );
    await manager1.linkDefaultPattern(defaultPiece);
    await manager1.runtime.idle();
    await manager1.synced();

    // Register one regular piece through the (healed) default pattern.
    const simple = await runtime1.patternManager.compilePattern(
      simplePieceProgram,
      { space },
    );
    const persisted = await manager1.runPersistent(
      simple,
      { value: 42 },
      "persisted-piece-t7",
    );
    await manager1.add([persisted]);
    await manager1.runtime.idle();
    await manager1.synced();
    await runtime1.patternManager.flushCompileCacheWrites();
    await runtime1.storageManager.synced();
    const persistedId = pieceId(persisted)!;
    expect(persistedId).toBeDefined();

    // --- Session 2: fresh runtime under a BUMPED runtimeVersion (the pin
    // bump): the compiled set written by session 1's heal is a miss, so the
    // default pattern must COLD-load from the legacy source docs. ---
    const restore = setCompileCacheRuntimeVersionForTesting(
      "cf-test-bumped-runtime-version-t7",
    );
    try {
      const runtime2 = newRuntime();
      const session2 = await createSession({ identity: signer, spaceName });
      const manager2 = new PieceManager(session2, runtime2);
      await manager2.synced();

      // The CT-1838 headline symptom was getPieces degrading to the
      // detached "empty-pieces" placeholder. With tolerance, the registry
      // loads.
      const piecesCell = await manager2.getPieces();
      const ids = piecesCell.get().map((piece) => pieceId(piece)).filter(
        Boolean,
      );
      expect(ids).toContain(persistedId);

      // And `cf piece new`-equivalent registration works end-to-end: run a
      // new piece and add it through the healed default pattern's addPiece
      // stream.
      const simple2 = await runtime2.patternManager.compilePattern(
        simplePieceProgram,
        { space },
      );
      const added = await manager2.runPersistent(
        simple2,
        { value: 7 },
        "added-after-bump-t7",
      );
      await manager2.add([added]);
      await manager2.runtime.idle();
      await manager2.synced();

      const afterAdd = await manager2.getPieces();
      const afterIds = afterAdd.get().map((piece) => pieceId(piece)).filter(
        Boolean,
      );
      expect(afterIds).toContain(persistedId);
      expect(afterIds).toContain(pieceId(added)!);
    } finally {
      restore();
    }
  });
});
