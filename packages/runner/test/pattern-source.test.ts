import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { getPatternSource, setPatternSource } from "../src/runner.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("patternSource meta accessors", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("round-trips a source string", async () => {
    const url = "/api/patterns/system/default-app.tsx";
    const { error } = await runtime.editWithRetry((tx) => {
      const cell = runtime.getCell(
        signer.did(),
        "pattern-source-roundtrip",
        undefined,
        tx,
      );
      setPatternSource(cell, tx, url);
      expect(getPatternSource(cell.withTx(tx))).toBe(url);
    });
    expect(error).toBeUndefined();
  });

  it("returns undefined when unset", async () => {
    const { error } = await runtime.editWithRetry((tx) => {
      const cell = runtime.getCell(
        signer.did(),
        "pattern-source-absent",
        undefined,
        tx,
      );
      expect(getPatternSource(cell.withTx(tx))).toBeUndefined();
    });
    expect(error).toBeUndefined();
  });
});
