import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { ALL_CHARMS_ID } from "../src/builtins/well-known.ts";

const signer = await Identity.fromPassphrase("wish built-in tests");
const space = signer.did();

describe("wish built-in", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: ReturnType<Runtime["edit"]>;
  let wish: ReturnType<typeof createBuilder>["commontools"]["wish"];
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder(runtime);
    ({ wish, recipe } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  it("resolves the well known all charms cell", async () => {
    const allCharmsCell = runtime.getCellFromEntityId(
      space,
      { "/": ALL_CHARMS_ID },
      [],
      undefined,
      tx,
    );
    const charmsData = [{ name: "Alpha" }];
    allCharmsCell.withTx(tx).set(charmsData);

    const wishRecipe = recipe("wish resolves all charms", () => {
      const allCharms = wish<Array<Record<string, unknown>>>("#/allCharms");
      return { allCharms };
    });

    const resultCell = runtime.getCell<{ allCharms?: unknown[] }>(
      space,
      "wish built-in result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishRecipe, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    const readTx = runtime.readTx();
    const actualCell = result.withTx(readTx).key("allCharms");
    const rawValue = actualCell.withTx(readTx).getRaw() as
      | { ["/"]: Record<string, unknown> }
      | undefined;
    const linkData = rawValue?.["/"]?.[LINK_V1_TAG] as
      | { id?: string; overwrite?: string }
      | undefined;

    expect(result.key("allCharms").get()).toEqual(charmsData);
    expect(linkData?.id).toEqual(`of:${ALL_CHARMS_ID}`);
  });

  it("returns undefined for unknown wishes", async () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const wishRecipe = recipe("wish unknown target", () => {
        const missing = wish("commontools://unknown");
        return { missing };
      });

      const resultCell = runtime.getCell<{ missing?: unknown }>(
        space,
        "wish built-in missing target",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      expect(result.key("missing").get()).toBeUndefined();
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.error = originalError;
    }
  });

  it("uses provided default when target is missing", async () => {
    const fallback = [{ name: "Fallback" }];

    const wishRecipe = recipe("wish default", () => {
      const missing = wish("#/missing", fallback);
      return { missing };
    });

    const resultCell = runtime.getCell<{ missing?: unknown }>(
      space,
      "wish built-in default",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishRecipe, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    expect(result.key("missing").get()).toEqual(fallback);
  });
});
