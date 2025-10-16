import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import {
  ALL_CHARMS_ID,
  DEFAULT_PATTERN_ID,
} from "../src/builtins/well-known.ts";

type DefaultPatternData = {
  backlinksIndex?: {
    mentions?: string[];
  };
};

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
      apiUrl: new URL("https://example.com"),
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
    const charmsData = [{ name: "Alpha", title: "Alpha" }];
    allCharmsCell.withTx(tx).set(charmsData);

    const wishRecipe = recipe("wish resolves all charms", () => {
      const allCharms = wish<Array<Record<string, unknown>>>("#/allCharms");
      const firstCharmTitle = wish("#allCharms/0/title");
      return { allCharms, firstCharmTitle };
    });

    const resultCell = runtime.getCell<{
      allCharms?: unknown[];
      firstCharmTitle?: string;
    }>(
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
    expect(result.key("firstCharmTitle").get()).toEqual(charmsData[0].title);
    expect(linkData?.id).toEqual(`of:${ALL_CHARMS_ID}`);
  });

  it("resolves the default charm result cell using slash target", async () => {
    const defaultPatternCell = runtime.getCellFromEntityId<DefaultPatternData>(
      space,
      { "/": DEFAULT_PATTERN_ID },
      [],
      undefined,
      tx,
    );
    const defaultPatternData = {
      backlinksIndex: { mentions: ["Alpha"] },
    };
    defaultPatternCell.withTx(tx).set(defaultPatternData);

    const wishRecipe = recipe("wish default result cell", () => {
      const defaultResult = wish("/");
      return { defaultResult };
    });

    const resultCell = runtime.getCell<{ defaultResult?: unknown }>(
      space,
      "wish built-in default result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishRecipe, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    const readTx = runtime.readTx();
    const defaultResultCell = result.withTx(readTx).key("defaultResult");
    const rawValue = defaultResultCell.withTx(readTx).getRaw() as
      | { ["/"]?: Record<string, unknown> }
      | undefined;
    const linkData = rawValue?.["/"]?.[LINK_V1_TAG] as
      | { id?: string; path?: (string | number)[] }
      | undefined;

    expect(linkData?.id).toEqual(`of:${DEFAULT_PATTERN_ID}`);
    expect(defaultResultCell.get()).toEqual(defaultPatternData);
  });

  it("resolves default charm subpaths using slash notation", async () => {
    const defaultPatternCell = runtime.getCellFromEntityId<DefaultPatternData>(
      space,
      { "/": DEFAULT_PATTERN_ID },
      [],
      undefined,
      tx,
    );
    defaultPatternCell.withTx(tx).set({
      backlinksIndex: { mentions: ["Alpha"] },
    });

    const wishRecipe = recipe("wish default subpaths", () => {
      return {
        backlinksLink: wish("/backlinksIndex"),
        mentionsLink: wish("/backlinksIndex/mentions"),
      };
    });

    const resultCell = runtime.getCell<{
      backlinksLink?: unknown;
      mentionsLink?: unknown;
    }>(
      space,
      "wish built-in default subpaths",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishRecipe, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    const readTx = runtime.readTx();

    const backlinksCell = result.withTx(readTx).key("backlinksLink");
    const backlinksRaw = backlinksCell.withTx(readTx).getRaw() as
      | { ["/"]?: Record<string, unknown> }
      | undefined;
    const backlinksLink = backlinksRaw?.["/"]?.[LINK_V1_TAG] as
      | { id?: string; path?: (string | number)[] }
      | undefined;
    expect(backlinksLink?.id).toEqual(`of:${DEFAULT_PATTERN_ID}`);
    expect(backlinksLink?.path).toEqual(["backlinksIndex"]);

    const mentionsCell = result.withTx(readTx).key("mentionsLink");
    const mentionsRaw = mentionsCell.withTx(readTx).getRaw() as
      | { ["/"]?: Record<string, unknown> }
      | undefined;
    const mentionsLink = mentionsRaw?.["/"]?.[LINK_V1_TAG] as
      | { id?: string; path?: (string | number)[] }
      | undefined;
    expect(mentionsLink?.id).toEqual(`of:${DEFAULT_PATTERN_ID}`);
    expect(mentionsLink?.path).toEqual(["backlinksIndex", "mentions"]);
    expect(mentionsCell.get()).toEqual(["Alpha"]);
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
