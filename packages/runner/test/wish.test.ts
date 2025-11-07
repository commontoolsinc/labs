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

    // Set up the space cell to link to allCharms
    const spaceCell = runtime.getCell<{ allCharms?: unknown[] }>(space, space)
      .withTx(tx);
    spaceCell.key("allCharms").set(allCharmsCell.withTx(tx));

    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    const wishRecipe = recipe("wish resolves all charms", () => {
      const allCharms = wish<Array<Record<string, unknown>>>("/allCharms");
      const firstCharmTitle = wish("/allCharms/0/title");
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
    await runtime.idle();
    tx = runtime.edit();

    await runtime.idle();

    const actualCell = result.key("allCharms");
    const rawValue = actualCell.getRaw() as
      | { ["/"]: Record<string, unknown> }
      | undefined;
    const linkData = rawValue?.["/"]?.[LINK_V1_TAG] as
      | { id?: string; overwrite?: string }
      | undefined;

    expect(result.key("allCharms").get()).toEqual(charmsData);
    expect(result.key("firstCharmTitle").get()).toEqual(charmsData[0].title);
    expect(linkData?.id).toEqual(`of:${ALL_CHARMS_ID}`);
  });

  it("resolves semantic wishes with # prefixes", async () => {
    const allCharmsCell = runtime.getCellFromEntityId(
      space,
      { "/": ALL_CHARMS_ID },
      [],
      undefined,
      tx,
    );
    const charmsData = [
      { name: "Alpha", title: "Alpha" },
      { name: "Beta", title: "Beta" },
    ];
    allCharmsCell.withTx(tx).set(charmsData);

    const spaceCell = runtime.getCell(space, space).withTx(tx);
    (spaceCell as any).key("allCharms").set(allCharmsCell.withTx(tx));

    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    const wishRecipe = recipe("wish semantic target", () => {
      return {
        semanticAllCharms: wish("#allCharms"),
        semanticFirstTitle: wish("#allCharms/0/title"),
      };
    });

    const resultCell = runtime.getCell<{
      semanticAllCharms?: unknown[];
      semanticFirstTitle?: string;
    }>(
      space,
      "wish semantic",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishRecipe, {}, resultCell);
    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    await runtime.idle();

    expect(result.key("semanticAllCharms").get()).toEqual(charmsData);
    expect(result.key("semanticFirstTitle").get()).toEqual("Alpha");
  });

  it("resolves the default pattern with #default", async () => {
    const spaceCell = runtime.getCell(space, space).withTx(tx);
    const defaultPatternCell = runtime.getCell(space, "default-pattern").withTx(
      tx,
    );
    const defaultData = {
      title: "Default App",
      argument: { greeting: "hello" },
    };
    defaultPatternCell.set(defaultData);
    (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    const wishRecipe = recipe("wish default pattern", () => {
      return {
        defaultTitle: wish("#default/title"),
        defaultGreeting: wish("#default/argument/greeting"),
      };
    });

    const resultCell = runtime.getCell<{
      defaultTitle?: string;
      defaultGreeting?: string;
    }>(
      space,
      "wish default pattern result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishRecipe, {}, resultCell);
    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    await runtime.idle();

    expect(result.key("defaultTitle").get()).toEqual("Default App");
    expect(result.key("defaultGreeting").get()).toEqual("hello");
  });

  it("resolves mentionable backlinks via #mentionable", async () => {
    const spaceCell = runtime.getCell(space, space).withTx(tx);
    const defaultPatternCell = runtime.getCell(space, "default-pattern").withTx(
      tx,
    );
    defaultPatternCell.set({
      backlinksIndex: {
        mentionable: [{ name: "Alpha" }, { name: "Beta" }],
      },
    });
    (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    const wishRecipe = recipe("wish mentionable", () => {
      return {
        mentionable: wish("#mentionable"),
        firstMentionable: wish("#mentionable/0/name"),
      };
    });

    const resultCell = runtime.getCell<{
      mentionable?: unknown[];
      firstMentionable?: string;
    }>(
      space,
      "wish mentionable result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishRecipe, {}, resultCell);
    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    await runtime.idle();

    expect(result.key("mentionable").get()).toEqual([
      { name: "Alpha" },
      { name: "Beta" },
    ]);
    expect(result.key("firstMentionable").get()).toEqual("Alpha");
  });

  it("resolves recent charms via #recent", async () => {
    const spaceCell = runtime.getCell(space, space).withTx(tx);
    const recentCharmsCell = runtime.getCell(space, "recent-charms", {
      type: "array",
      items: { type: "object" },
    }).withTx(tx);
    const recentData = [{ name: "Charm A" }, { name: "Charm B" }];
    recentCharmsCell.set(recentData);
    (spaceCell as any).key("recentCharms").set(recentCharmsCell);

    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    const wishRecipe = recipe("wish recent charms", () => {
      return {
        recent: wish("#recent"),
        recentFirst: wish("#recent/0/name"),
      };
    });

    const resultCell = runtime.getCell<{
      recent?: unknown[];
      recentFirst?: string;
    }>(
      space,
      "wish recent charms result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishRecipe, {}, resultCell);
    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    await runtime.idle();

    expect(result.key("recent").get()).toEqual(recentData);
    expect(result.key("recentFirst").get()).toEqual("Charm A");
  });

  it("returns current timestamp via #now", async () => {
    const wishRecipe = recipe("wish now", () => {
      return { nowValue: wish("#now") };
    });

    const resultCell = runtime.getCell<{ nowValue?: number }>(
      space,
      "wish now result",
      undefined,
      tx,
    );
    const before = Date.now();
    const result = runtime.run(tx, wishRecipe, {}, resultCell);
    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    await runtime.idle();

    const after = Date.now();
    const nowValue = result.key("nowValue").get();
    expect(typeof nowValue).toBe("number");
    expect(nowValue).toBeGreaterThanOrEqual(before);
    expect(nowValue).toBeLessThanOrEqual(after);
  });

  it("resolves the space cell using slash target", async () => {
    // Create the space cell (cause = space DID)
    const spaceCell = runtime.getCell(
      space,
      space, // Use space DID as cause
    ).withTx(tx);
    const spaceData = {
      testField: "space cell value",
    };
    spaceCell.withTx(tx).set(spaceData);

    const wishRecipe = recipe("wish space cell", () => {
      const spaceResult = wish("/");
      return { spaceResult };
    });

    const resultCell = runtime.getCell<{ spaceResult?: unknown }>(
      space,
      "wish built-in space",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishRecipe, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    const readTx = runtime.readTx();
    const spaceResultCell = result.withTx(readTx).key("spaceResult");

    expect(spaceResultCell.get()).toEqual(spaceData);
  });

  it("resolves space cell subpaths using slash notation", async () => {
    // Create the space cell with nested data
    const spaceCell = runtime.getCell(
      space,
      space, // Use space DID as cause
    ).withTx(tx);
    spaceCell.withTx(tx).set({
      config: { setting: "value" },
      nested: { deep: { data: ["Alpha"] } },
    });

    const wishRecipe = recipe("wish space subpaths", () => {
      return {
        configLink: wish("/config"),
        dataLink: wish("/nested/deep/data"),
      };
    });

    const resultCell = runtime.getCell<{
      configLink?: unknown;
      dataLink?: unknown;
    }>(
      space,
      "wish built-in space subpaths",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishRecipe, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    const readTx = runtime.readTx();

    const configCell = result.withTx(readTx).key("configLink");
    expect(configCell.get()).toEqual({ setting: "value" });

    const dataCell = result.withTx(readTx).key("dataLink");
    expect(dataCell.get()).toEqual(["Alpha"]);
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

    // Set up space cell with an empty default pattern
    const spaceCell = runtime.getCell(space, space).withTx(tx);
    const defaultPatternCell = runtime.getCell(space, "default-pattern").withTx(
      tx,
    );
    defaultPatternCell.set({}); // Empty default pattern
    (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    const wishRecipe = recipe("wish default", () => {
      const missing = wish("/missing", fallback);
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
    await runtime.idle();
    tx = runtime.edit();

    await runtime.idle();

    expect(result.key("missing").get()).toEqual(fallback);
  });
});
