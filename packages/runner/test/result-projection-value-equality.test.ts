import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { Pattern } from "../src/builder/types.ts";

// Setting up a pattern over a result cell that already holds a projection
// writes only when the projection differs from what is stored. A result whose
// only difference is inside a `FabricPrimitive` is a difference: those keep
// their state in private `#fields`, so a comparison that walks enumerable own
// properties sees two distinct values as identical and drops the write.

const signer = await Identity.fromPassphrase(
  "result-projection-value-equality",
);
const space = signer.did();

function patternWithBytes(bytes: number[]): Pattern {
  return {
    argumentSchema: { type: "object", properties: {} } as const,
    resultSchema: undefined,
    result: { data: new FabricBytes(new Uint8Array(bytes)) },
    nodes: [],
  } as unknown as Pattern;
}

function storedBytes(runtime: Runtime, cause: string): number[] {
  const raw = runtime.getCell(space, cause, undefined).getRaw() as {
    data: FabricBytes;
  };
  return [...raw.data.slice()];
}

describe("result projection", () => {
  it("re-projects when only the bytes of a result value change", async () => {
    const storage = EmulatedStorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const tx = runtime.edit();
      runtime.run(
        tx,
        patternWithBytes([1, 2, 3]),
        {},
        runtime.getCell(space, "bytes-result", undefined, tx),
      );
      await tx.commit();
      expect(storedBytes(runtime, "bytes-result")).toEqual([1, 2, 3]);

      const tx2 = runtime.edit();
      runtime.run(
        tx2,
        patternWithBytes([9, 9, 9]),
        {},
        runtime.getCell(space, "bytes-result", undefined, tx2),
      );
      await tx2.commit();
      expect(storedBytes(runtime, "bytes-result")).toEqual([9, 9, 9]);
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });

  it("keeps a FabricPrimitive result value intact through binding", async () => {
    const storage = EmulatedStorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const tx = runtime.edit();
      runtime.run(
        tx,
        patternWithBytes([4, 5]),
        {},
        runtime.getCell(space, "intact", undefined, tx),
      );
      await tx.commit();

      const raw = runtime.getCell(space, "intact", undefined).getRaw() as {
        data: unknown;
      };
      // Rebuilding the value from its enumerable own properties would leave a
      // plain empty object here.
      expect(raw.data).toBeInstanceOf(FabricBytes);
      expect([...(raw.data as FabricBytes).slice()]).toEqual([4, 5]);
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });
});
