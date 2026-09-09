import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { setPatternCell } from "../src/result-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner-result-utils");

describe("result-utils", () => {
  const withRuntime = async (
    body: (runtime: Runtime) => Promise<void>,
  ): Promise<void> => {
    const storageManager = StorageManager.emulate({ as: signer });
    try {
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      try {
        await body(runtime);
      } finally {
        await runtime.dispose();
      }
    } finally {
      await storageManager.close();
    }
  };

  describe("setPatternCell()", () => {
    it("copies the parent pattern's value into the result cell's `pattern` meta field", async () => {
      await withRuntime(async (runtime) => {
        const tx = runtime.edit();
        const patternCell = runtime.getCell<{ note: string }>(
          signer.did(),
          "result-utils-parent-pattern",
          undefined,
          tx,
        );
        patternCell.set({ note: "parent" });
        const resultCell = runtime.getCell(
          signer.did(),
          "result-utils-result",
          undefined,
          tx,
        );

        setPatternCell(resultCell, patternCell);
        await tx.commit();

        expect(resultCell.getMetaRaw("pattern")).toEqual({ note: "parent" });
      });
    });

    it("leaves the `pattern` meta field unwritten when the parent pattern has no value", async () => {
      await withRuntime(async (runtime) => {
        const tx = runtime.edit();
        const patternCell = runtime.getCell(
          signer.did(),
          "result-utils-empty-parent",
          undefined,
          tx,
        );
        const resultCell = runtime.getCell(
          signer.did(),
          "result-utils-unwritten-result",
          undefined,
          tx,
        );

        setPatternCell(resultCell, patternCell);
        await tx.commit();

        expect(resultCell.getMetaRaw("pattern")).toBeUndefined();
      });
    });
  });
});
