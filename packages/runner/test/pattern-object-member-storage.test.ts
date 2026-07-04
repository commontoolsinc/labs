// Characterization test: what does the runtime do when a pattern's result
// object literal contains a function member (a method) versus a getter?
//
// A pattern `.tsx` file that returns `{ read() {...} }` no longer compiles,
// because the ts-transformers pattern-context validation pass rejects
// object-literal methods/getters/setters. So this test builds the pattern
// through the BUILDER API directly (createBuilder -> commonfabric.pattern),
// which is plain function calls and is not run through that validator. The
// recipe callback returns an object literal with a method (or a getter), which
// constructs fine; the question is purely what the RUNTIME does with that
// member when the result is run and read.
//
// Two candidate outcomes were considered up front:
//   (a) THROW — storing the result throws "Cannot store function per se (needs
//       to have a `toJSON()` method)" (packages/data-model native-conversion).
//   (b) DROP — the function member is silently dropped (the result schema /
//       projection omits function members before storage) and the rest of the
//       result is stored fine.
//
// OBSERVED OUTCOME (recorded after running against the real runtime). The two
// member kinds behave DIFFERENTLY:
//
//   * METHOD member (`read() { ... }`) -> THROW. The member is a live function
//     on the materialized result object. When `Runner.updateResultProjection`
//     converts the result with `fabricFromNativeValue(result)`, the function
//     reaches `shallowFabricFromNativeValue` and throws
//       "Cannot store function per se (needs to have a `toJSON()` method)"
//     (packages/data-model/src/native-conversion.ts:229). The throw happens
//     synchronously inside `runtime.run(...)` at setup time, before any commit.
//
//   * GETTER member (`get derived() { return 2; }`) -> NOT a function at all by
//     the time the runtime sees it. A getter on an object literal is invoked
//     when the object is built, so the result object already carries a plain
//     data property `derived: 2`. The runtime stores it like any other field:
//     both `ok` and `derived` survive, and `derived` reads back as `2`.
//
// So for the method case the answer is THROW, not DROP. The getter case never
// presents a function to the storage layer and is kept as plain data.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern result object with a function member", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  const bindBuilder = () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    ({ pattern } = commonfabric);
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    bindBuilder();
  });

  async function commitTx() {
    if (tx.status().status !== "ready") {
      return { ok: undefined, error: undefined };
    }
    runtime.prepareTxForCommit(tx);
    return await tx.commit();
  }

  afterEach(async () => {
    await commitTx();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("throws when the result object carries a method member", () => {
    // The pattern returns an object literal carrying both a plain field and a
    // method. Built through the builder API, this constructs without error...
    const methodPattern = pattern<
      Record<string, never>,
      { ok: boolean; read(): number }
    >(() => {
      return {
        ok: true,
        read() {
          return 1;
        },
      };
    });

    const resultCell = runtime.getCell<{ ok?: boolean; read?: unknown }>(
      space,
      "pattern-object-member-storage: method",
      undefined,
      tx,
    );

    // ...but running it throws synchronously at result-projection time, when
    // the live function is converted to a fabric value. The error originates in
    // packages/data-model/src/native-conversion.ts.
    expect(() => runtime.run(tx, methodPattern, {}, resultCell)).toThrow(
      "Cannot store function per se (needs to have a `toJSON()` method)",
    );
  });

  it("keeps a getter member's evaluated value alongside the plain field", async () => {
    // A getter on the result object literal is invoked when the object is
    // built, so the runtime only ever sees a plain data property. Nothing is
    // dropped and nothing throws.
    const getterPattern = pattern<
      Record<string, never>,
      { ok: boolean; derived: number }
    >(() => {
      return {
        ok: true,
        get derived() {
          return 2;
        },
      };
    });

    const resultCell = runtime.getCell<{ ok?: boolean; derived?: number }>(
      space,
      "pattern-object-member-storage: getter",
      undefined,
      tx,
    );

    const result = runtime.run(tx, getterPattern, {}, resultCell);
    await commitTx();
    tx = runtime.edit();

    const value = await result.pull();

    expect(result.key("ok").get()).toBe(true);
    // The getter's value survived as plain data, not as a function.
    expect(result.key("derived").get()).toBe(2);
    expect(typeof (value as Record<string, unknown>)?.derived).not.toBe(
      "function",
    );
    expect(Object.keys((value ?? {}) as Record<string, unknown>)).toEqual(
      ["derived", "ok"],
    );
  });
});
