import type { CollectionIndexData } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { collectionKeyBucket } from "../src/builtins/collection-index-key.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("collection-index-resume");

describe("collection index resume", () => {
  it("resumes a stored lookup in a fresh runtime and follows bucket insertion", async () => {
    const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const firstStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const secondStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const first = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: firstStorage,
    });
    const second = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: secondStorage,
    });
    const program = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
      import {pattern, GroupIndex} from "commonfabric";
      export default pattern<{index: GroupIndex<string, number>}>(
        ({index}) => ({values: index.lookup("a")})
      );
    `,
      }],
    };
    let cancelFirst: (() => void) | undefined;
    let cancelSecond: (() => void) | undefined;
    try {
      const compiled = await first.patternManager.compilePattern(program);
      const tx = first.edit();
      const index = first.getCell<CollectionIndexData<string, number[]>>(
        signer.did(),
        "index",
        undefined,
        tx,
      );
      index.set({
        kind: "collection-index",
        mode: "group",
        keys: [],
        keyEntries: [],
        buckets: {},
      });
      const result = first.run(
        tx,
        compiled,
        { index },
        first.getCell<{ values: number[] }>(
          signer.did(),
          "output",
          compiled.resultSchema,
          tx,
        ),
      );
      first.prepareTxForCommit(tx);
      await tx.commit();
      cancelFirst = result.sink(() => {});
      await first.idle();
      expect(await result.key("values").pull()).toEqual([]);
      await firstStorage.synced();
      cancelFirst();
      cancelFirst = undefined;
      first.runner.stop(result);
      await first.dispose({ closeStorage: false });
      await firstStorage.close();
      await second.patternManager.compilePattern(program, {
        space: signer.did(),
      });
      const restored = second.getCellFromLink<{ values: number[] }>(
        result.getAsNormalizedFullLink(),
      );
      cancelSecond = restored.sink(() => {});
      expect(await second.start(restored)).toBe(true);
      await second.idle();
      expect(await restored.key("values").pull()).toEqual([]);
      const edit = second.edit();
      const restoredIndex = second.getCellFromLink<
        CollectionIndexData<string, number[]>
      >(index.getAsNormalizedFullLink(), undefined, edit);
      restoredIndex.key("buckets").key(
        collectionKeyBucket({ kind: "string", value: "a" }),
      ).set([7]);
      restoredIndex.key("keys").set(["a"]);
      restoredIndex.key("keyEntries").set([{ kind: "value", value: "a" }]);
      await edit.commit();
      await second.idle();
      expect(await restored.key("values").pull()).toEqual([7]);
    } finally {
      cancelFirst?.();
      cancelSecond?.();
      await first.dispose({ closeStorage: false });
      await secondStorage.synced();
      await second.dispose({ closeStorage: false });
      await firstStorage.close();
      await secondStorage.close();
      await server.close();
    }
  });
});
