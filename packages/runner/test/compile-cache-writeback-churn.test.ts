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

const signer = await Identity.fromPassphrase("writeback churn test");
const space = signer.did();

const program = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "import { double } from './dep.ts';",
        "import { label } from './dep2.ts';",
        "export default pattern<{ value: number }>(({ value }) => {",
        "  return { result: double(value), label: label(value) };",
        "});",
      ].join("\n"),
    },
    {
      name: "/dep.ts",
      contents: [
        "import { lift } from 'commonfabric';",
        "import { unit } from './dep2.ts';",
        "export const double = lift((x: number) => x * 2 * unit);",
      ].join("\n"),
    },
    {
      name: "/dep2.ts",
      contents: [
        "import { lift } from 'commonfabric';",
        "export const unit = 1;",
        "export const label = lift((x: number) => `n=${x}`);",
      ].join("\n"),
    },
  ],
};

describe("compile-cache write-back over successive runtime versions", () => {
  it("lands on every version bump, so a later cold runtime hits by identity", async () => {
    // The clone's shape: a program whose source docs already exist from
    // earlier builds is recompiled by each new runtime version, and each
    // write-back rewrites the source docs' import element docs. Every
    // write-back must land, or every later call recompiles.
    const server = newSharedServer();
    const restoreVersion = setCompileCacheRuntimeVersionForTesting("churn-v0");
    const managers: EmulatedStorageManager[] = [];
    const runtimes: Runtime[] = [];
    const open = () => {
      const sm = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
      });
      managers.push(sm);
      runtimes.push(runtime);
      return { sm, runtime };
    };
    try {
      const first = open();
      const tx = first.runtime.edit();
      const compiled = await first.runtime.patternManager.compilePattern(
        program,
        { space, tx },
      );
      const ref = first.runtime.patternManager.getArtifactEntryRef(compiled)!;
      await first.runtime.patternManager.flushCompileCacheWrites();
      await tx.commit();
      await first.sm.synced();

      // The documents the entry's import edges live in are named by the
      // edges, so every later write-back of the same closure lands on the
      // same documents instead of minting new ones.
      const edgeDocIds = async (
        { sm, runtime }: { sm: EmulatedStorageManager; runtime: Runtime },
      ) => {
        const entry = runtime.getCell(
          space,
          sourceDocKey(ref.identity),
          WRITE_TARGET_EDGE_SYNC_SCHEMA,
        );
        await entry.sync();
        const raw = (sm.open(space) as unknown as {
          get(id: string): { value?: { imports?: unknown[] } } | undefined;
        }).get(entry.getAsNormalizedFullLink().id);
        return (raw?.value?.imports ?? []).map((el) =>
          (el as { "/"?: { "link@1"?: { id?: string } } })?.["/"]?.["link@1"]
            ?.id
        );
      };
      const firstEdges = await edgeDocIds(first);
      // Two authored imports and the synthetic root link.
      expect(firstEdges.length).toBe(3);
      expect(firstEdges.every((id) => typeof id === "string")).toBe(true);

      for (const version of ["churn-v1", "churn-v2", "churn-v3", "churn-v4"]) {
        setCompileCacheRuntimeVersionForTesting(version);
        const cold = open();
        const loaded = await cold.runtime.patternManager.loadPatternByIdentity(
          ref.identity,
          ref.symbol,
          space,
        );
        expect(loaded).toBeDefined();
        await cold.runtime.patternManager.flushCompileCacheWrites();
        await cold.sm.synced();

        const warm = open();
        await warm.runtime.patternManager.loadPatternByIdentity(
          ref.identity,
          ref.symbol,
          space,
        );
        expect(
          warm.runtime.patternManager.getCompileCacheStats().byIdentityHits,
        ).toBeGreaterThan(0);
        expect(await edgeDocIds(warm)).toEqual(firstEdges);
      }
    } finally {
      restoreVersion();
      for (const runtime of runtimes.reverse()) await runtime.dispose();
      for (const sm of managers.reverse()) await sm.close();
      await server.close();
    }
  });
});
