import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test proxy fabric instance");
const space = signer.did();

// A `FabricInstance` holds all of its state in private fields and exposes it
// through accessors on its prototype. Reading one through the query-result
// proxy has to evaluate the accessor against the instance itself: a private
// field is unreachable from the proxy, which does not declare it, so an
// accessor run with the proxy as receiver throws outright rather than
// returning a wrong answer.
//
// `FabricError` stands in for the whole tree here because it is the instance a
// cell write actually produces -- `Cell.set()` of a native `Error` wraps one --
// and it is the state-heaviest of the concrete classes.
describe("query-result proxy: FabricInstance accessors read through to the instance", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("returns each fixed-schema slot of a stored `FabricError`", () => {
    const cell = runtime.getCell<unknown>(space, "errorCell", undefined, tx);
    cell.set(new TypeError("something went wrong"));

    const result = cell.get() as {
      type: string;
      name: string;
      message: string;
      stack: string;
    };
    expect(result.type).toBe("TypeError");
    expect(result.name).toBe("TypeError");
    expect(result.message).toBe("something went wrong");
    expect(typeof result.stack).toBe("string");
  });

  it("returns a slot of a nested `FabricError` reached through `cause`", () => {
    const cell = runtime.getCell<unknown>(space, "causeCell", undefined, tx);
    cell.set(new Error("outer", { cause: new RangeError("inner") }));

    const result = cell.get() as {
      message: string;
      cause: { type: string; message: string };
    };
    expect(result.message).toBe("outer");
    expect(result.cause.type).toBe("RangeError");
    expect(result.cause.message).toBe("inner");
  });
});
