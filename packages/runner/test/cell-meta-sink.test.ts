import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import { getSigilLink } from "../src/runner-utils.ts";
import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { Cancel } from "../src/cancel.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

type MetaSinkCell = Cell<unknown> & {
  sinkMeta<T extends FabricValue = FabricValue>(
    metaField: "pattern",
    callback: (value: T | undefined) => Cancel | undefined | void,
  ): Cancel;
};

describe("Cell meta subscriptions", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("re-runs when the pattern meta field changes", async () => {
    const pattern1: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { value: 1 },
      nodes: [],
    };
    const pattern2: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { value: 2 },
      nodes: [],
    };

    const patternId1 = runtime.patternManager.registerPattern(pattern1);
    const patternId2 = runtime.patternManager.registerPattern(pattern2);
    const resultCell = runtime.getCell(
      space,
      "pattern-meta-subscription",
    ) as MetaSinkCell;

    const initialTx = runtime.edit();
    resultCell.withTx(initialTx).setMetaRaw(
      "pattern",
      getSigilLink(patternId1),
    );
    await initialTx.commit();

    const seenPatternIds: Array<string | undefined> = [];
    const cancel = resultCell.sinkMeta("pattern", (value) => {
      seenPatternIds.push(parseLink(value, resultCell)?.id);
    });

    expect(seenPatternIds).toEqual([patternId1]);

    const updateTx = runtime.edit();
    resultCell.withTx(updateTx).setMetaRaw("pattern", getSigilLink(patternId2));
    await updateTx.commit();
    await runtime.idle();

    expect(seenPatternIds).toEqual([patternId1, patternId2]);
    cancel();
  });
});
