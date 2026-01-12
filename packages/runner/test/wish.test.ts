import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { ALL_CHARMS_ID } from "../src/builtins/well-known.ts";
import { UI } from "../src/builder/types.ts";
import { parseWishTarget } from "../src/builtins/wish.ts";

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

    const { commontools } = createBuilder();
    ({ wish, recipe } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  it("resolves the well known all charms cell", async () => {
    const allCharmsCell = runtime.getCellFromEntityId<unknown[]>(
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
    tx = runtime.edit();

    // Pull to trigger computation
    await result.pull();

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

    // Set up the space cell with defaultPattern that links to allCharms
    const spaceCell = runtime.getCell(space, space).withTx(tx);
    const defaultPatternCell = runtime.getCell(space, "default-pattern").withTx(
      tx,
    );
    (defaultPatternCell as any).key("allCharms").set(allCharmsCell.withTx(tx));
    (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

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
    tx = runtime.edit();

    // Pull to trigger computation
    await result.pull();

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
    tx = runtime.edit();

    // Pull to trigger computation
    await result.pull();

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
    tx = runtime.edit();

    await result.pull();

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

    // Set up defaultPattern to own recentCharms
    const defaultPatternCell = runtime.getCell(space, "default-pattern").withTx(
      tx,
    );
    (defaultPatternCell as any).key("recentCharms").set(recentCharmsCell);
    (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

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
    tx = runtime.edit();

    await result.pull();

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
    tx = runtime.edit();

    await result.pull();

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

    await result.pull();

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

    await result.pull();

    const readTx = runtime.readTx();

    const configCell = result.withTx(readTx).key("configLink");
    expect(configCell.get()).toEqual({ setting: "value" });

    const dataCell = result.withTx(readTx).key("dataLink");
    expect(dataCell.get()).toEqual(["Alpha"]);
  });

  it("returns error for unknown wishes", async () => {
    const wishRecipe = recipe("wish unknown target", () => {
      const missing = wish("commontools://unknown");
      return { missing };
    });

    const resultCell = runtime.getCell<{ missing?: { error?: string } }>(
      space,
      "wish built-in missing target",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishRecipe, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const missingResult = result.key("missing").get();
    // Unknown wish targets now return an error object for better UX
    expect(missingResult?.error).toMatch(/not recognized/);
  });

  describe("object-based wish syntax", () => {
    it("resolves allCharms using tag parameter", async () => {
      const allCharmsCell = runtime.getCellFromEntityId<unknown[]>(
        space,
        { "/": ALL_CHARMS_ID },
        [],
        undefined,
        tx,
      );
      const charmsData = [{ name: "Alpha", title: "Alpha" }];
      allCharmsCell.withTx(tx).set(charmsData);

      // Set up defaultPattern to own allCharms
      const spaceCell = runtime.getCell<{ allCharms?: unknown[] }>(space, space)
        .withTx(tx);
      const defaultPatternCell = runtime.getCell(space, "default-pattern")
        .withTx(tx);
      (defaultPatternCell as any).key("allCharms").set(
        allCharmsCell.withTx(tx),
      );
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishRecipe = recipe("wish object syntax allCharms", () => {
        const allCharms = wish<unknown[]>({ query: "#allCharms" });
        return { allCharms };
      });

      const resultCell = runtime.getCell<{
        allCharms?: { result?: unknown[] };
      }>(
        space,
        "wish object syntax result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("allCharms").get()?.result).toEqual(charmsData);
    });

    it("resolves nested paths using tag and path parameters", async () => {
      const allCharmsCell = runtime.getCellFromEntityId<unknown[]>(
        space,
        { "/": ALL_CHARMS_ID },
        [],
        undefined,
        tx,
      );
      const charmsData = [
        { name: "Alpha", title: "First Title" },
        { name: "Beta", title: "Second Title" },
      ];
      allCharmsCell.withTx(tx).set(charmsData);

      // Set up defaultPattern to own allCharms
      const spaceCell = runtime.getCell<{ allCharms?: unknown[] }>(space, space)
        .withTx(tx);
      const defaultPatternCell = runtime.getCell(space, "default-pattern")
        .withTx(tx);
      (defaultPatternCell as any).key("allCharms").set(
        allCharmsCell.withTx(tx),
      );
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishRecipe = recipe("wish object syntax with path", () => {
        const firstTitle = wish<string>({
          query: "#allCharms",
          path: ["0", "title"],
        });
        return { firstTitle };
      });

      const resultCell = runtime.getCell<{
        firstTitle?: { result?: string };
      }>(
        space,
        "wish object syntax path result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("firstTitle").get()?.result).toEqual("First Title");
    });

    it("resolves space cell using / tag", async () => {
      const spaceCell = runtime.getCell(space, space).withTx(tx);
      const spaceData = { testField: "space cell value" };
      spaceCell.set(spaceData);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishRecipe = recipe("wish object syntax space", () => {
        const spaceResult = wish({ query: "/" });
        return { spaceResult };
      });

      const resultCell = runtime.getCell<{
        spaceResult?: { result?: unknown };
      }>(
        space,
        "wish object syntax space result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("spaceResult").get()?.result).toEqual(spaceData);
    });

    it("resolves space cell subpaths using / tag with path", async () => {
      const spaceCell = runtime.getCell(space, space).withTx(tx);
      spaceCell.set({
        config: { setting: "value" },
        nested: { deep: { data: ["Alpha"] } },
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishRecipe = recipe("wish object syntax space subpaths", () => {
        return {
          configLink: wish({ query: "/", path: ["config"] }),
          dataLink: wish({ query: "/", path: ["nested", "deep", "data"] }),
        };
      });

      const resultCell = runtime.getCell<{
        configLink?: { result?: unknown };
        dataLink?: { result?: unknown };
      }>(
        space,
        "wish object syntax space subpaths result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("configLink").get()?.result).toEqual({
        setting: "value",
      });
      expect(result.key("dataLink").get()?.result).toEqual(["Alpha"]);
    });

    it("returns current timestamp via #now tag", async () => {
      const wishRecipe = recipe("wish object syntax now", () => {
        return { nowValue: wish({ query: "#now" }) };
      });

      const resultCell = runtime.getCell<{
        nowValue?: { result?: number };
      }>(
        space,
        "wish object syntax now result",
        undefined,
        tx,
      );
      const before = Date.now();
      const result = runtime.run(tx, wishRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const after = Date.now();
      const nowValue = result.key("nowValue").get()?.result;
      expect(typeof nowValue).toBe("number");
      expect(nowValue).toBeGreaterThanOrEqual(before);
      expect(nowValue).toBeLessThanOrEqual(after);
    });

    it("returns error for unknown tag", async () => {
      const wishRecipe = recipe("wish object syntax unknown", () => {
        const missing = wish({ query: "#unknownTag" });
        return { missing };
      });

      const resultCell = runtime.getCell<{
        missing?: { result?: unknown };
      }>(
        space,
        "wish object syntax unknown result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const missingResult = result.key("missing").get();
      // Unknown tags now search favorites, returning "No favorite found" error
      expect(missingResult?.error).toMatch(/No favorite found matching/);
    });

    it("returns error when tag is missing", async () => {
      const wishRecipe = recipe("wish object syntax no tag", () => {
        const missing = wish({ query: "", path: ["some", "path"] });
        return { missing };
      });

      const resultCell = runtime.getCell<{
        missing?: { error?: string };
      }>(
        space,
        "wish object syntax no tag result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const missingResult = result.key("missing").get();
      expect(missingResult?.error).toMatch(/no query/);
    });

    it("returns UI with ct-cell-link on success", async () => {
      const spaceCell = runtime.getCell(space, space).withTx(tx);
      const spaceData = { testField: "space cell value" };
      spaceCell.set(spaceData);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishRecipe = recipe("wish object syntax UI success", () => {
        const spaceResult = wish({ query: "/" });
        return { spaceResult };
      });

      const resultCell = runtime.getCell<{
        spaceResult?: { result?: unknown };
      }>(
        space,
        "wish object syntax UI success result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const wishResult = result.key("spaceResult").get() as Record<
        string | symbol,
        unknown
      >;
      expect(wishResult?.error).toBeUndefined();
      expect(wishResult?.result).toEqual(spaceData);

      const ui = wishResult?.[UI] as { type: string; name: string; props: any };
      expect(ui?.type).toEqual("vnode");
      expect(ui?.name).toEqual("ct-cell-link");
      expect(ui?.props?.$cell).toBeDefined();
    });

    it("returns UI with error message on failure", async () => {
      const errors: unknown[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args);
      };

      try {
        const wishRecipe = recipe("wish object syntax UI error", () => {
          const missing = wish({ query: "#unknownTag" });
          return { missing };
        });

        const resultCell = runtime.getCell<{
          missing?: { error?: string };
        }>(
          space,
          "wish object syntax UI error result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishRecipe, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        await result.pull();

        const wishResult = result.key("missing").get() as Record<
          string | symbol,
          unknown
        >;
        // Unknown tags now search favorites, returning "No favorite found" error
        expect(wishResult?.error).toMatch(/No favorite found matching/);

        const ui = wishResult?.[UI] as {
          type: string;
          name: string;
          props: any;
          children: string;
        };
        expect(ui?.type).toEqual("vnode");
        expect(ui?.name).toEqual("span");
        expect(ui?.props?.style).toEqual("color: red");
        expect(ui?.children).toMatch(/⚠️/);
        expect(ui?.children).toMatch(/No favorite found matching/);
      } finally {
        console.error = originalError;
      }
    });
  });

  describe("compiled pattern with object-based wish syntax", () => {
    it("preserves object syntax through compilation pipeline", async () => {
      // This test ensures that wish({ query: "..." }) object syntax works
      // when patterns are compiled and deployed (CT-1084)
      const spaceCell = runtime.getCell(space, space).withTx(tx);
      const spaceData = { testField: "compiled pattern value" };
      spaceCell.set(spaceData);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Compile a pattern that uses object-based wish syntax
      const program = {
        main: "/main.tsx",
        files: [
          {
            name: "/main.tsx",
            contents: [
              "import { recipe, wish } from 'commontools';",
              "export default recipe<{}>('Compiled Wish Test', () => {",
              "  const spaceResult = wish({ query: '/' });",
              "  return { spaceResult };",
              "});",
            ].join("\n"),
          },
        ],
      };

      const compiled = await runtime.recipeManager.compileRecipe(program);
      const recipeId = runtime.recipeManager.registerRecipe(compiled, program);
      const loadedRecipe = await runtime.recipeManager.loadRecipe(
        recipeId,
        space,
        tx,
      );

      const resultCell = runtime.getCell<{
        spaceResult?: { result?: unknown };
      }>(
        space,
        "compiled wish test result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, loadedRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // The wish should resolve to the space cell data, wrapped in { result: ... }
      expect(result.key("spaceResult").get()?.result).toEqual(spaceData);
    });

    it("preserves object syntax with path through compilation", async () => {
      const spaceCell = runtime.getCell(space, space).withTx(tx);
      spaceCell.set({
        nested: { deep: { value: "found it" } },
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const program = {
        main: "/main.tsx",
        files: [
          {
            name: "/main.tsx",
            contents: [
              "import { recipe, wish } from 'commontools';",
              "export default recipe<{}>('Compiled Wish Path Test', () => {",
              "  const deepValue = wish({ query: '/', path: ['nested', 'deep', 'value'] });",
              "  return { deepValue };",
              "});",
            ].join("\n"),
          },
        ],
      };

      const compiled = await runtime.recipeManager.compileRecipe(program);
      const recipeId = runtime.recipeManager.registerRecipe(compiled, program);
      const loadedRecipe = await runtime.recipeManager.loadRecipe(
        recipeId,
        space,
        tx,
      );

      const resultCell = runtime.getCell<{
        deepValue?: { result?: string };
      }>(
        space,
        "compiled wish path test result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, loadedRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("deepValue").get()?.result).toEqual("found it");
    });
  });

  describe("cross-space wish resolution", () => {
    let userIdentity: Identity;
    let patternSpace: Identity;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let tx: ReturnType<Runtime["edit"]>;
    let wish: ReturnType<typeof createBuilder>["commontools"]["wish"];
    let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];

    beforeEach(async () => {
      userIdentity = await Identity.fromPassphrase("user-home-space");
      patternSpace = await Identity.fromPassphrase("pattern-space-1");

      // Key: storageManager.as determines home space (user identity)
      storageManager = StorageManager.emulate({ as: userIdentity });
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      tx = runtime.edit();

      const { commontools } = createBuilder();
      ({ wish, recipe } = commontools);
    });

    afterEach(async () => {
      await tx.commit();
      await runtime.dispose();
      await storageManager.close();
    });

    it("resolves #favorites from home space when pattern runs in different space", async () => {
      // Setup: Add favorites to home space through defaultPattern
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const defaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = defaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item",
        undefined,
        tx,
      );
      favoriteItem.set({ name: "My Favorite", value: 42 });
      favoritesCell.set([
        { cell: favoriteItem, tag: "test favorite" },
      ]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Run pattern in different space (patternSpace)
      const wishRecipe = recipe("wish favorites cross-space", () => {
        return { favorites: wish({ query: "#favorites" }) };
      });

      const resultCell = runtime.getCell<{
        favorites?: { result?: unknown[] };
      }>(
        patternSpace.did(), // Pattern runs in different space
        "wish-favorites-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Favorites resolved from home space, not pattern space
      const favorites = result.key("favorites").get()?.result;
      expect(favorites).toBeDefined();
      expect(Array.isArray(favorites)).toBe(true);
      expect((favorites as any[])[0].tag).toEqual("test favorite");
    });

    it("resolves #default from pattern space, not home space", async () => {
      // Setup: Add different #default data to home space
      const homeSpaceCell = runtime.getCell(
        userIdentity.did(),
        userIdentity.did(),
      ).withTx(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default",
      ).withTx(tx);
      homeDefaultCell.set({ title: "Home Default", value: "home" });
      homeSpaceCell.key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add different #default data to pattern space
      const patternSpaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const patternDefaultCell = runtime.getCell(
        patternSpace.did(),
        "pattern-default",
      ).withTx(tx);
      patternDefaultCell.set({ title: "Pattern Default", value: "pattern" });
      patternSpaceCell.key("defaultPattern").set(patternDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Run pattern in pattern space that wishes for #default
      const wishRecipe = recipe("wish default cross-space", () => {
        return { defaultData: wish({ query: "#default" }) };
      });

      const resultCell = runtime.getCell<{
        defaultData?: { result?: unknown };
      }>(
        patternSpace.did(),
        "wish-default-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Gets pattern space's #default, not home space's
      const defaultData = result.key("defaultData").get()?.result;
      expect(defaultData).toEqual({
        title: "Pattern Default",
        value: "pattern",
      });
    });

    it("resolves mixed tags (#favorites from home, / from pattern) in single pattern", async () => {
      // Setup: Favorites in home space through defaultPattern
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const defaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = defaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-mixed",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      favoritesCell.set([{ cell: favoriteItem, tag: "mixed test" }]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: /data in pattern space
      const patternSpaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      patternSpaceCell.set({ data: { type: "pattern" } });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Single pattern wishes for both
      const wishRecipe = recipe("wish mixed tags", () => {
        return {
          favorites: wish({ query: "#favorites" }),
          patternData: wish({ query: "/", path: ["data"] }),
        };
      });

      const resultCell = runtime.getCell<{
        favorites?: { result?: unknown[] };
        patternData?: { result?: unknown };
      }>(
        patternSpace.did(),
        "wish-mixed-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Each resolves to correct space
      const favorites = result.key("favorites").get()?.result;
      const patternData = result.key("patternData").get()?.result;

      expect(Array.isArray(favorites)).toBe(true);
      expect((favorites as any[])[0].tag).toEqual("mixed test");
      expect(patternData).toEqual({ type: "pattern" });
    });

    it("resolves hashtag search in home space favorites from different pattern space", async () => {
      // Setup: Favorites with tags in home space through defaultPattern
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const defaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = defaultPatternCell.key("favorites");
      const favoriteItem1 = runtime.getCell(
        userIdentity.did(),
        "hashtag-item-1",
        undefined,
        tx,
      );
      favoriteItem1.set({ name: "Item with #myTag" });
      const favoriteItem2 = runtime.getCell(
        userIdentity.did(),
        "hashtag-item-2",
        undefined,
        tx,
      );
      favoriteItem2.set({ name: "Different item" });

      favoritesCell.set([
        { cell: favoriteItem1, tag: "#myTag #awesome" },
        { cell: favoriteItem2, tag: "no hashtag here" },
      ]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Pattern in different space wishes for #myTag
      const wishRecipe = recipe("wish hashtag search", () => {
        return { taggedItem: wish({ query: "#myTag" }) };
      });

      const resultCell = runtime.getCell<{
        taggedItem?: { result?: unknown };
      }>(
        patternSpace.did(),
        "wish-hashtag-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Searches home space favorites, finds correct cell
      const taggedItem = result.key("taggedItem").get()?.result;
      expect(taggedItem).toEqual({ name: "Item with #myTag" });
    });

    it("starts charm automatically when accessed via cross-space wish", async () => {
      // Setup 1: Create a simple counter recipe/charm
      const counterRecipe = recipe<{ count: number }>("counter charm", () => {
        const count = 0;
        return {
          count,
          increment: () => {
            return count + 1;
          },
        };
      });

      // Setup 2: Store the charm in home space
      const charmCell = runtime.getCell(
        userIdentity.did(),
        "counter-charm",
        undefined,
        tx,
      );
      // Setup the charm (but don't start it yet)
      runtime.setup(tx, counterRecipe, {}, charmCell);

      // Setup 3: Add charm to favorites through defaultPattern
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const defaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = defaultPatternCell.key("favorites");
      favoritesCell.set([
        { cell: charmCell, tag: "#counterCharm test charm" },
      ]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Pattern in different space wishes for the charm via hashtag
      const wishingRecipe = recipe("wish for charm", () => {
        return { charmData: wish({ query: "#counterCharm" }) };
      });

      const resultCell = runtime.getCell<{
        charmData?: { result?: unknown };
      }>(
        patternSpace.did(),
        "wish-charm-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishingRecipe, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Wish triggered charm to start and returns running charm data
      const charmData = result.key("charmData").get()?.result;
      expect(charmData).toBeDefined();
      expect(typeof charmData).toBe("object");

      // The charm should be running and have its state accessible
      // Note: This test may need adjustment based on actual charm startup behavior
      if (typeof charmData === "object" && charmData !== null) {
        expect("count" in charmData || "increment" in charmData).toBe(true);
      }
    });
  });
});

describe("parseWishTarget", () => {
  it("parses absolute paths starting with /", () => {
    const result = parseWishTarget("/allCharms");
    expect(result).toEqual({ key: "/", path: ["allCharms"] });
  });

  it("parses nested absolute paths", () => {
    const result = parseWishTarget("/allCharms/0/title");
    expect(result).toEqual({ key: "/", path: ["allCharms", "0", "title"] });
  });

  it("parses hash tag targets", () => {
    const result = parseWishTarget("#favorites");
    expect(result).toEqual({ key: "#favorites", path: [] });
  });

  it("parses hash tag targets with path", () => {
    const result = parseWishTarget("#favorites/list/0");
    expect(result).toEqual({ key: "#favorites", path: ["list", "0"] });
  });

  it("trims whitespace", () => {
    const result = parseWishTarget("  /allCharms  ");
    expect(result).toEqual({ key: "/", path: ["allCharms"] });
  });

  it("filters empty segments", () => {
    const result = parseWishTarget("/allCharms//nested/");
    expect(result).toEqual({ key: "/", path: ["allCharms", "nested"] });
  });

  it("throws on empty string", () => {
    expect(() => parseWishTarget("")).toThrow('Wish target "" is empty');
  });

  it("throws on whitespace-only string", () => {
    expect(() => parseWishTarget("   ")).toThrow("is empty");
  });

  it("throws on unrecognized path format", () => {
    expect(() => parseWishTarget("noSlashOrHash")).toThrow("is not recognized");
  });

  it("throws on hash-only target", () => {
    expect(() => parseWishTarget("#")).toThrow("is not recognized");
  });
});
