import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { ALL_PIECES_ID } from "../src/builtins/well-known.ts";
import { NAME, UI } from "../src/builder/types.ts";
import { parseWishTarget, tagMatchesHashtag } from "../src/builtins/wish.ts";

const signer = await Identity.fromPassphrase("wish built-in tests");
const space = signer.did();

describe("wish built-in", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: ReturnType<Runtime["edit"]>;
  let wish: ReturnType<typeof createBuilder>["commontools"]["wish"];
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({ wish, pattern } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  it("resolves the well known all pieces cell", async () => {
    const allPiecesCell = runtime.getCellFromEntityId<unknown[]>(
      space,
      { "/": ALL_PIECES_ID },
      [],
      undefined,
      tx,
    );
    const piecesData = [{ name: "Alpha", title: "Alpha" }];
    allPiecesCell.withTx(tx).set(piecesData);

    // Set up the space cell to link to allPieces
    const spaceCell = runtime.getCell<{ allPieces?: unknown[] }>(space, space)
      .withTx(tx);
    spaceCell.key("allPieces").set(allPiecesCell.withTx(tx));

    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    const wishPattern = pattern("wish resolves all pieces", () => {
      const allPieces = wish<Array<Record<string, unknown>>>({
        query: "/allPieces",
      });
      const firstPieceTitle = wish({ query: "/allPieces/0/title" });
      return { allPieces, firstPieceTitle };
    });

    const resultCell = runtime.getCell<{
      allPieces?: { result?: unknown[] };
      firstPieceTitle?: { result?: string };
    }>(
      space,
      "wish built-in result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    // Pull to trigger computation
    await result.pull();

    const wishResultCell = result.key("allPieces");
    const allPiecesResultCell = wishResultCell.key("result");
    const rawValue = allPiecesResultCell.getRaw() as
      | { ["/"]: Record<string, unknown> }
      | undefined;
    const linkData = rawValue?.["/"]?.[LINK_V1_TAG] as
      | { id?: string; overwrite?: string }
      | undefined;

    expect(result.key("allPieces").get()?.result).toEqual(piecesData);
    expect(result.key("firstPieceTitle").get()?.result).toEqual(
      piecesData[0].title,
    );
    expect(linkData?.id).toEqual(`of:${ALL_PIECES_ID}`);
  });

  it("resolves semantic wishes with # prefixes", async () => {
    const allPiecesCell = runtime.getCellFromEntityId(
      space,
      { "/": ALL_PIECES_ID },
      [],
      undefined,
      tx,
    );
    const piecesData = [
      { name: "Alpha", title: "Alpha" },
      { name: "Beta", title: "Beta" },
    ];
    allPiecesCell.withTx(tx).set(piecesData);

    // Set up the space cell with defaultPattern that links to allPieces
    const spaceCell = runtime.getCell(space, space).withTx(tx);
    const defaultPatternCell = runtime.getCell(space, "default-pattern").withTx(
      tx,
    );
    (defaultPatternCell as any).key("allPieces").set(allPiecesCell.withTx(tx));
    (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    const wishPattern = pattern("wish semantic target", () => {
      return {
        semanticAllPieces: wish({ query: "#allPieces" }),
        semanticFirstTitle: wish({ query: "#allPieces/0/title" }),
      };
    });

    const resultCell = runtime.getCell<{
      semanticAllPieces?: { result?: unknown[] };
      semanticFirstTitle?: { result?: string };
    }>(
      space,
      "wish semantic",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    // Pull to trigger computation
    await result.pull();

    expect(result.key("semanticAllPieces").get()?.result).toEqual(piecesData);
    expect(result.key("semanticFirstTitle").get()?.result).toEqual("Alpha");
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

    const wishPattern = pattern("wish default pattern", () => {
      return {
        defaultTitle: wish({ query: "#default/title" }),
        defaultGreeting: wish({ query: "#default/argument/greeting" }),
      };
    });

    const resultCell = runtime.getCell<{
      defaultTitle?: { result?: string };
      defaultGreeting?: { result?: string };
    }>(
      space,
      "wish default pattern result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    // Pull to trigger computation
    await result.pull();

    expect(result.key("defaultTitle").get()?.result).toEqual("Default App");
    expect(result.key("defaultGreeting").get()?.result).toEqual("hello");
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

    const wishPattern = pattern("wish mentionable", () => {
      return {
        mentionable: wish({ query: "#mentionable" }),
        firstMentionable: wish({ query: "#mentionable/0/name" }),
      };
    });

    const resultCell = runtime.getCell<{
      mentionable?: { result?: unknown[] };
      firstMentionable?: { result?: string };
    }>(
      space,
      "wish mentionable result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    expect(result.key("mentionable").get()?.result).toEqual([
      { name: "Alpha" },
      { name: "Beta" },
    ]);
    expect(result.key("firstMentionable").get()?.result).toEqual("Alpha");
  });

  it("resolves recent pieces via #recent", async () => {
    const spaceCell = runtime.getCell(space, space).withTx(tx);
    const recentPiecesCell = runtime.getCell(space, "recent-pieces", {
      type: "array",
      items: { type: "object" },
    }).withTx(tx);
    const recentData = [{ name: "Piece A" }, { name: "Piece B" }];
    recentPiecesCell.set(recentData);

    // Set up defaultPattern to own recentPieces
    const defaultPatternCell = runtime.getCell(space, "default-pattern").withTx(
      tx,
    );
    (defaultPatternCell as any).key("recentPieces").set(recentPiecesCell);
    (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    const wishPattern = pattern("wish recent pieces", () => {
      return {
        recent: wish({ query: "#recent" }),
        recentFirst: wish({ query: "#recent/0/name" }),
      };
    });

    const resultCell = runtime.getCell<{
      recent?: { result?: unknown[] };
      recentFirst?: { result?: string };
    }>(
      space,
      "wish recent pieces result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    expect(result.key("recent").get()?.result).toEqual(recentData);
    expect(result.key("recentFirst").get()?.result).toEqual("Piece A");
  });

  it("returns current timestamp via #now", async () => {
    const wishPattern = pattern("wish now", () => {
      return { nowValue: wish({ query: "#now" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "wish now result",
      undefined,
      tx,
    );
    const before = Date.now();
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const after = Date.now();
    const nowValue = result.key("nowValue").get()?.result;
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

    const wishPattern = pattern("wish space cell", () => {
      const spaceResult = wish({ query: "/" });
      return { spaceResult };
    });

    const resultCell = runtime.getCell<{ spaceResult?: { result?: unknown } }>(
      space,
      "wish built-in space",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const readTx = runtime.readTx();
    const spaceResultCell = result.withTx(readTx).key("spaceResult");

    expect(spaceResultCell.get()?.result).toEqual(spaceData);
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

    const wishPattern = pattern("wish space subpaths", () => {
      return {
        configLink: wish({ query: "/config" }),
        dataLink: wish({ query: "/nested/deep/data" }),
      };
    });

    const resultCell = runtime.getCell<{
      configLink?: { result?: unknown };
      dataLink?: { result?: unknown };
    }>(
      space,
      "wish built-in space subpaths",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const readTx = runtime.readTx();

    const configCell = result.withTx(readTx).key("configLink");
    expect(configCell.get()?.result).toEqual({ setting: "value" });

    const dataCell = result.withTx(readTx).key("dataLink");
    expect(dataCell.get()?.result).toEqual(["Alpha"]);
  });

  it("returns error for unknown wishes", async () => {
    const wishPattern = pattern("wish unknown target", () => {
      const missing = wish({ query: "" });
      return { missing };
    });

    const resultCell = runtime.getCell<{ missing?: { error?: string } }>(
      space,
      "wish built-in missing target",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const missingResult = result.key("missing").get();
    // Empty query returns an error object
    expect(missingResult?.error).toMatch(/no query/);
  });

  describe("object-based wish syntax", () => {
    it("resolves allPieces using tag parameter", async () => {
      const allPiecesCell = runtime.getCellFromEntityId<unknown[]>(
        space,
        { "/": ALL_PIECES_ID },
        [],
        undefined,
        tx,
      );
      const piecesData = [{ name: "Alpha", title: "Alpha" }];
      allPiecesCell.withTx(tx).set(piecesData);

      // Set up defaultPattern to own allPieces
      const spaceCell = runtime.getCell<{ allPieces?: unknown[] }>(space, space)
        .withTx(tx);
      const defaultPatternCell = runtime.getCell(space, "default-pattern")
        .withTx(tx);
      (defaultPatternCell as any).key("allPieces").set(
        allPiecesCell.withTx(tx),
      );
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern("wish object syntax allPieces", () => {
        const allPieces = wish<unknown[]>({ query: "#allPieces" });
        return { allPieces };
      });

      const resultCell = runtime.getCell<{
        allPieces?: { result?: unknown[] };
      }>(
        space,
        "wish object syntax result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("allPieces").get()?.result).toEqual(piecesData);
    });

    it("resolves nested paths using tag and path parameters", async () => {
      const allPiecesCell = runtime.getCellFromEntityId<unknown[]>(
        space,
        { "/": ALL_PIECES_ID },
        [],
        undefined,
        tx,
      );
      const piecesData = [
        { name: "Alpha", title: "First Title" },
        { name: "Beta", title: "Second Title" },
      ];
      allPiecesCell.withTx(tx).set(piecesData);

      // Set up defaultPattern to own allPieces
      const spaceCell = runtime.getCell<{ allPieces?: unknown[] }>(space, space)
        .withTx(tx);
      const defaultPatternCell = runtime.getCell(space, "default-pattern")
        .withTx(tx);
      (defaultPatternCell as any).key("allPieces").set(
        allPiecesCell.withTx(tx),
      );
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern("wish object syntax with path", () => {
        const firstTitle = wish<string>({
          query: "#allPieces",
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
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("firstTitle").get()?.result).toEqual("First Title");
    });

    it("resolves slashed path embedded in tag query", async () => {
      const allPiecesCell = runtime.getCellFromEntityId<unknown[]>(
        space,
        { "/": ALL_PIECES_ID },
        [],
        undefined,
        tx,
      );
      const piecesData = [
        { name: "Alpha", title: "First Title" },
        { name: "Beta", title: "Second Title" },
      ];
      allPiecesCell.withTx(tx).set(piecesData);

      // Set up defaultPattern to own allPieces
      const spaceCell = runtime.getCell<{ allPieces?: unknown[] }>(space, space)
        .withTx(tx);
      const defaultPatternCell = runtime.getCell(space, "default-pattern")
        .withTx(tx);
      (defaultPatternCell as any).key("allPieces").set(
        allPiecesCell.withTx(tx),
      );
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern("wish object syntax slashed query", () => {
        const firstTitle = wish<string>({
          query: "#allPieces/0/title",
        });
        return { firstTitle };
      });

      const resultCell = runtime.getCell<{
        firstTitle?: { result?: string };
      }>(
        space,
        "wish object syntax slashed query result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
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

      const wishPattern = pattern("wish object syntax space", () => {
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
      const result = runtime.run(tx, wishPattern, {}, resultCell);
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

      const wishPattern = pattern("wish object syntax space subpaths", () => {
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
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("configLink").get()?.result).toEqual({
        setting: "value",
      });
      expect(result.key("dataLink").get()?.result).toEqual(["Alpha"]);
    });

    it("returns current timestamp via #now tag", async () => {
      const wishPattern = pattern("wish object syntax now", () => {
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
      const result = runtime.run(tx, wishPattern, {}, resultCell);
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
      const wishPattern = pattern("wish object syntax unknown", () => {
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
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const missingResult = result.key("missing").get();
      // Unknown tags now search favorites, returning "No favorites found" error
      expect(missingResult?.error).toMatch(/No favorites found matching/);
    });

    it("returns error when tag is missing", async () => {
      const wishPattern = pattern("wish object syntax no tag", () => {
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
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const missingResult = result.key("missing").get();
      expect(missingResult?.error).toMatch(/no query/);
    });

    it("returns cell UI or ct-cell-link fallback on success", async () => {
      const spaceCell = runtime.getCell(space, space).withTx(tx);
      const spaceData = { testField: "space cell value" };
      spaceCell.set(spaceData);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern("wish object syntax UI success", () => {
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
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const wishResult = result.key("spaceResult").get() as Record<
        string | symbol,
        unknown
      >;
      expect(wishResult?.error).toBeUndefined();
      expect(wishResult?.result).toEqual(spaceData);

      // Plain data has no [UI], so falls back to ct-cell-link
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
        const wishPattern = pattern("wish object syntax UI error", () => {
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
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        await result.pull();

        const wishResult = result.key("missing").get() as Record<
          string | symbol,
          unknown
        >;
        // Unknown tags now search favorites, returning "No favorites found" error
        expect(wishResult?.error).toMatch(/No favorites found matching/);

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
        expect(ui?.children).toMatch(/No favorites found matching/);
      } finally {
        console.error = originalError;
      }
    });

    it("returns unified shape with candidates for single result", async () => {
      const spaceCell = runtime.getCell(space, space).withTx(tx);
      const spaceData = { testField: "unified shape test" };
      spaceCell.set(spaceData);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern("wish unified shape candidates", () => {
        const spaceResult = wish({ query: "/" });
        return { spaceResult };
      });

      const resultCell = runtime.getCell<{
        spaceResult?: { result?: unknown; candidates?: unknown[] };
      }>(
        space,
        "wish unified shape result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const wishResult = result.key("spaceResult").get() as Record<
        string | symbol,
        unknown
      >;
      // Unified shape: result is present
      expect(wishResult?.result).toEqual(spaceData);
      // Unified shape: candidates is present (array containing the single match)
      expect(wishResult?.candidates).toBeDefined();
      expect(Array.isArray(wishResult?.candidates)).toBe(true);
      expect((wishResult?.candidates as unknown[]).length).toBe(1);
    });
  });

  describe("scope-based wish search", () => {
    let userIdentity: Identity;
    let patternSpace: Identity;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let tx: ReturnType<Runtime["edit"]>;
    let wish: ReturnType<typeof createBuilder>["commontools"]["wish"];
    let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];

    beforeEach(async () => {
      userIdentity = await Identity.fromPassphrase("scope-test-user");
      patternSpace = await Identity.fromPassphrase("scope-pattern-space");
      storageManager = StorageManager.emulate({ as: userIdentity });
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      tx = runtime.edit();

      const { commontools } = createBuilder();
      ({ wish, pattern } = commontools);
    });

    afterEach(async () => {
      await tx.commit();
      await runtime.dispose();
      await storageManager.close();
    });

    it('searches only mentionables with scope: ["."]', async () => {
      // Setup: Add favorites to home space (should NOT be found)
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      favoritesCell.set([{ cell: favoriteItem, tag: "#test-tag" }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add mentionables to pattern space (should be found)
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        patternSpace.did(),
        "space-default-pattern",
        undefined,
        tx,
      );
      const backlinksIndexCell = runtime.getCell(
        patternSpace.did(),
        "backlinks-index",
        undefined,
        tx,
      );
      const mentionableItem = runtime.getCell(
        patternSpace.did(),
        "mentionable-item",
        undefined,
        tx,
      );
      const mentionableData: any = { type: "mentionable" };
      mentionableData[NAME] = "test-tag";
      mentionableItem.set(mentionableData);
      // Set up backlinksIndex as a separate cell with mentionable array
      backlinksIndexCell.set({
        mentionable: [mentionableItem],
      });
      // defaultPattern references backlinksIndex as a cell
      defaultPatternCell.set({
        backlinksIndex: backlinksIndexCell,
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Search with scope: ["."] should find only mentionable
      const wishPattern = pattern("scope mentionable only", () => {
        return { result: wish({ query: "#test-tag", scope: ["."] }) };
      });

      const resultCell = runtime.getCell<{
        result?: { result?: unknown };
      }>(
        patternSpace.did(),
        "scope-mentionable-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Should find mentionable, not favorite
      const wishResult = result.key("result").get();
      if (wishResult?.error) {
        console.log("Error in wish:", wishResult.error);
      }
      const foundItem = wishResult?.result;
      expect(foundItem).toBeDefined();
      const data = (foundItem as any).get?.() ?? foundItem;
      expect(data.type).toBe("mentionable");
    });

    it('searches only favorites with scope: ["~"]', async () => {
      // Setup: Add favorites to home space (should be found)
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      favoritesCell.set([{ cell: favoriteItem, tag: "#test-tag" }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add mentionables to pattern space (with same tag - should NOT be found)
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        patternSpace.did(),
        "space-default-pattern",
        undefined,
        tx,
      );
      const backlinksIndexCell = runtime.getCell(
        patternSpace.did(),
        "backlinks-index-fav",
        undefined,
        tx,
      );
      const mentionableItem = runtime.getCell(
        patternSpace.did(),
        "mentionable-item",
        undefined,
        tx,
      );
      const mentionableData: any = { type: "mentionable" };
      mentionableData[NAME] = "test-tag";
      mentionableItem.set(mentionableData);
      backlinksIndexCell.set({
        mentionable: [mentionableItem],
      });
      defaultPatternCell.set({
        backlinksIndex: backlinksIndexCell,
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Search with scope: ["~"] should find only favorite
      const wishPattern = pattern("scope favorites only", () => {
        return { result: wish({ query: "#test-tag", scope: ["~"] }) };
      });

      const resultCell = runtime.getCell<{
        result?: { result?: unknown };
      }>(
        patternSpace.did(),
        "scope-favorites-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Should find favorite, not mentionable
      const wishResult = result.key("result").get();
      if (wishResult?.error) {
        console.log("Error in scope favorites test:", wishResult.error);
      }
      const foundItem = wishResult?.result;
      expect(foundItem).toBeDefined();
      const data = (foundItem as any).get?.() ?? foundItem;
      expect(data.type).toBe("favorite");
    });

    it('searches both favorites and mentionables with scope: ["~", "."]', async () => {
      // Setup: Add favorites to home space
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      favoritesCell.set([{ cell: favoriteItem, tag: "#fav-tag" }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add mentionables to pattern space
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        patternSpace.did(),
        "space-default-pattern",
        undefined,
        tx,
      );
      const backlinksIndexCell = runtime.getCell(
        patternSpace.did(),
        "backlinks-index-both",
        undefined,
        tx,
      );
      const mentionableItem = runtime.getCell(
        patternSpace.did(),
        "mentionable-item",
        undefined,
        tx,
      );
      const mentionableData: any = { type: "mentionable" };
      mentionableData[NAME] = "ment-tag";
      mentionableItem.set(mentionableData);
      backlinksIndexCell.set({
        mentionable: [mentionableItem],
      });
      defaultPatternCell.set({
        backlinksIndex: backlinksIndexCell,
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Search with scope: ["~", "."] should find favorite
      const wishPattern1 = pattern("scope both find favorite", () => {
        return { result: wish({ query: "#fav-tag", scope: ["~", "."] }) };
      });

      const resultCell1 = runtime.getCell<{
        result?: { result?: unknown };
      }>(
        patternSpace.did(),
        "scope-both-fav-result",
        undefined,
        tx,
      );
      const result1 = runtime.run(tx, wishPattern1, {}, resultCell1);
      await tx.commit();
      tx = runtime.edit();

      await result1.pull();

      // Verify: Should find favorite
      const foundFavorite = result1.key("result").get()?.result;
      expect(foundFavorite).toBeDefined();
      const favoriteData = (foundFavorite as any).get?.() ?? foundFavorite;
      expect(favoriteData.type).toBe("favorite");

      // Execute: Search with scope: ["~", "."] should find mentionable
      const wishPattern2 = pattern("scope both find mentionable", () => {
        return { result: wish({ query: "#ment-tag", scope: ["~", "."] }) };
      });

      const resultCell2 = runtime.getCell<{
        result?: { result?: unknown };
      }>(
        patternSpace.did(),
        "scope-both-ment-result",
        undefined,
        tx,
      );
      const result2 = runtime.run(tx, wishPattern2, {}, resultCell2);
      await tx.commit();
      tx = runtime.edit();

      await result2.pull();

      // Verify: Should find mentionable
      const foundMentionable = result2.key("result").get()?.result;
      expect(foundMentionable).toBeDefined();
      const mentData = (foundMentionable as any).get?.() ??
        foundMentionable;
      expect(mentData.type).toBe("mentionable");
    });

    it("searches favorites only by default (no scope parameter)", async () => {
      // Setup: Add favorites to home space (should be found)
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      favoritesCell.set([{ cell: favoriteItem, tag: "#test-tag" }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add mentionables to pattern space (with same tag - should NOT be found)
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        patternSpace.did(),
        "space-default-pattern",
        undefined,
        tx,
      );
      const backlinksIndexCell = runtime.getCell(
        patternSpace.did(),
        "backlinks-index-default",
        undefined,
        tx,
      );
      const mentionableItem = runtime.getCell(
        patternSpace.did(),
        "mentionable-item",
        undefined,
        tx,
      );
      const mentionableData: any = { type: "mentionable" };
      mentionableData[NAME] = "test-tag";
      mentionableItem.set(mentionableData);
      backlinksIndexCell.set({
        mentionable: [mentionableItem],
      });
      defaultPatternCell.set({
        backlinksIndex: backlinksIndexCell,
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Search without scope parameter should default to favorites only
      const wishPattern = pattern("default scope", () => {
        return { result: wish({ query: "#test-tag" }) };
      });

      const resultCell = runtime.getCell<{
        result?: { result?: unknown };
      }>(
        patternSpace.did(),
        "default-scope-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Should find favorite (not mentionable) by default
      const foundItem = result.key("result").get()?.result;
      expect(foundItem).toBeDefined();
      const data = (foundItem as any).get?.() ?? foundItem;
      expect(data.type).toBe("favorite");
    });

    it("scope parameter changes error message for mentionable-only search", async () => {
      // Setup: No favorites with "nonexistent" tag
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      favoritesCell.set([]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: No mentionables with "nonexistent" tag
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        patternSpace.did(),
        "space-default-pattern",
      ).withTx(tx);
      defaultPatternCell.set({
        backlinksIndex: {
          mentionable: [],
        },
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Search with mentionable scope only should give mentionable-specific error
      const wishPattern = pattern("scope error test", () => {
        return { result: wish({ query: "#nonexistent", scope: ["."] }) };
      });

      const resultCell = runtime.getCell<{
        result?: { error?: string };
      }>(
        patternSpace.did(),
        "scope-error-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Error message mentions "mentionables" not "favorites"
      const resultData = result.key("result").get();
      expect(resultData?.error).toBeDefined();
      expect(resultData?.error).toContain("mentionables");
      expect(resultData?.error).not.toContain("favorites");
    });

    it("returns error when no matches found in mentionable scope", async () => {
      // Setup: Add only favorites (no mentionables)
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      favoritesCell.set([{ cell: favoriteItem, tag: "#test-tag" }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup empty mentionables in pattern space
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        patternSpace.did(),
        "space-default-pattern",
      ).withTx(tx);
      defaultPatternCell.set({
        backlinksIndex: {
          mentionable: [],
        },
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Search with mentionable scope only should fail (even though favorites has it)
      const wishPattern = pattern("no mentionable match", () => {
        return { result: wish({ query: "#test-tag", scope: ["."] }) };
      });

      const resultCell = runtime.getCell<{
        result?: { error?: string };
      }>(
        patternSpace.did(),
        "no-match-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Should return error
      const resultData = result.key("result").get();
      expect(resultData?.error).toBeDefined();
      expect(resultData?.error).toMatch(/No mentionables found matching/i);
    });

    it('#default with scope: ["~"] resolves against home space', async () => {
      // Setup: Add default pattern to home space
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "home-default-pattern-tilde",
        undefined,
        tx,
      );
      homeDefaultPatternCell.set({
        title: "Home Default",
        value: "from-home",
      });
      (homeSpaceCell as any).key("defaultPattern").set(
        homeDefaultPatternCell,
      );

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add different default pattern to current space
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const currentDefaultPattern = runtime.getCell(
        patternSpace.did(),
        "current-default-pattern-tilde",
        undefined,
        tx,
      );
      currentDefaultPattern.set({
        title: "Current Default",
        value: "from-current",
      });
      (spaceCell as any).key("defaultPattern").set(currentDefaultPattern);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: #default with scope: ["~"] should resolve from home space
      const wishPattern = pattern("default with tilde scope", () => {
        return {
          result: wish({
            query: "#default",
            scope: ["~"],
          }),
        };
      });

      const resultCell = runtime.getCell<{
        result?: { result?: unknown };
      }>(
        patternSpace.did(),
        "default-tilde-scope-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Should return home space's default pattern, not current space's
      const wishResult = result.key("result").get();
      expect(wishResult?.error).toBeUndefined();
      const defaultData = wishResult?.result;
      expect(defaultData).toBeDefined();
      expect((defaultData as any)?.title).toBe("Home Default");
      expect((defaultData as any)?.value).toBe("from-home");
    });

    describe("arbitrary DID scope", () => {
      let otherSpace: Identity;

      beforeEach(async () => {
        otherSpace = await Identity.fromPassphrase("other-space-arbitrary");
      });

      it("searches mentionables in arbitrary DID space with scope: [did]", async () => {
        // Setup: Add mentionables to the "other" space
        const otherSpaceCell = runtime.getCell(
          otherSpace.did(),
          otherSpace.did(),
        ).withTx(tx);
        const otherDefaultPattern = runtime.getCell(
          otherSpace.did(),
          "other-default-pattern",
          undefined,
          tx,
        );
        const otherBacklinksIndex = runtime.getCell(
          otherSpace.did(),
          "other-backlinks-index",
          undefined,
          tx,
        );
        const otherMentionable = runtime.getCell(
          otherSpace.did(),
          "other-mentionable-item",
          undefined,
          tx,
        );
        const mentionableData: any = { type: "from-other-space" };
        mentionableData[NAME] = "arb-tag";
        otherMentionable.set(mentionableData);
        otherBacklinksIndex.set({
          mentionable: [otherMentionable],
        });
        otherDefaultPattern.set({
          backlinksIndex: otherBacklinksIndex,
        });
        (otherSpaceCell as any).key("defaultPattern").set(otherDefaultPattern);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Execute: Search with scope containing the arbitrary DID
        const wishPattern = pattern("scope arbitrary did", () => {
          return {
            result: wish({
              query: "#arb-tag",
              scope: [otherSpace.did()],
            }),
          };
        });

        const resultCell = runtime.getCell<{
          result?: { result?: unknown };
        }>(
          patternSpace.did(),
          "scope-arb-did-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        await result.pull();

        // Verify: Should find the mentionable from the other space
        const wishResult = result.key("result").get();
        if (wishResult?.error) {
          console.log("Error in arbitrary DID scope test:", wishResult.error);
        }
        const foundItem = wishResult?.result;
        expect(foundItem).toBeDefined();
        const data = (foundItem as any).get?.() ?? foundItem;
        expect(data.type).toBe("from-other-space");
      });

      it('searches both current space and arbitrary DID with scope: [".", did]', async () => {
        // Setup: Add mentionables to pattern space (current space)
        const spaceCell = runtime.getCell(
          patternSpace.did(),
          patternSpace.did(),
        ).withTx(tx);
        const defaultPatternCell = runtime.getCell(
          patternSpace.did(),
          "space-default-pattern-arb",
          undefined,
          tx,
        );
        const backlinksIndexCell = runtime.getCell(
          patternSpace.did(),
          "backlinks-index-arb",
          undefined,
          tx,
        );
        const currentMentionable = runtime.getCell(
          patternSpace.did(),
          "current-mentionable",
          undefined,
          tx,
        );
        const currentData: any = { type: "from-current-space" };
        currentData[NAME] = "multi-tag";
        currentMentionable.set(currentData);
        backlinksIndexCell.set({
          mentionable: [currentMentionable],
        });
        defaultPatternCell.set({
          backlinksIndex: backlinksIndexCell,
        });
        (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Setup: Add mentionables to other space with same tag
        const otherSpaceCell = runtime.getCell(
          otherSpace.did(),
          otherSpace.did(),
        ).withTx(tx);
        const otherDefaultPattern = runtime.getCell(
          otherSpace.did(),
          "other-default-pattern-multi",
          undefined,
          tx,
        );
        const otherBacklinksIndex = runtime.getCell(
          otherSpace.did(),
          "other-backlinks-index-multi",
          undefined,
          tx,
        );
        const otherMentionable = runtime.getCell(
          otherSpace.did(),
          "other-mentionable-multi",
          undefined,
          tx,
        );
        const otherData: any = { type: "from-other-space" };
        otherData[NAME] = "multi-tag";
        otherMentionable.set(otherData);
        otherBacklinksIndex.set({
          mentionable: [otherMentionable],
        });
        otherDefaultPattern.set({
          backlinksIndex: otherBacklinksIndex,
        });
        (otherSpaceCell as any).key("defaultPattern").set(otherDefaultPattern);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Execute: Search with scope: [".", otherSpace.did()]
        const wishPattern = pattern("scope dot and did", () => {
          return {
            result: wish({
              query: "#multi-tag",
              scope: [".", otherSpace.did()],
            }),
          };
        });

        const resultCell = runtime.getCell<{
          result?: { result?: unknown; candidates?: unknown[] };
        }>(
          patternSpace.did(),
          "scope-dot-and-did-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        await result.pull();

        // Verify: Should find matches (candidates from both spaces)
        const wishResult = result.key("result").get();
        expect(wishResult?.error).toBeUndefined();
        // The result should be defined (first match = current space due to ordering)
        expect(wishResult?.result).toBeDefined();
        const resultData = (wishResult?.result as any)?.get?.() ??
          wishResult?.result;
        // Current space match should be preferred (comes first in ordering)
        expect(resultData.type).toBe("from-current-space");
      });

      it('searches favorites and arbitrary DID with scope: ["~", did]', async () => {
        // Setup: Add favorites to home space
        const homeSpaceCell = runtime.getHomeSpaceCell(tx);
        const homeDefaultPatternCell = runtime.getCell(
          userIdentity.did(),
          "default-pattern-arb-fav",
          undefined,
          tx,
        );
        const favoritesCell = homeDefaultPatternCell.key("favorites");
        const favoriteItem = runtime.getCell(
          userIdentity.did(),
          "favorite-arb-item",
          undefined,
          tx,
        );
        favoriteItem.set({ type: "from-favorites" });
        favoritesCell.set([{ cell: favoriteItem, tag: "#combo-tag" }]);
        (homeSpaceCell as any).key("defaultPattern").set(
          homeDefaultPatternCell,
        );

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Setup: Add mentionables to other space with same tag
        const otherSpaceCell = runtime.getCell(
          otherSpace.did(),
          otherSpace.did(),
        ).withTx(tx);
        const otherDefaultPattern = runtime.getCell(
          otherSpace.did(),
          "other-default-pattern-combo",
          undefined,
          tx,
        );
        const otherBacklinksIndex = runtime.getCell(
          otherSpace.did(),
          "other-backlinks-index-combo",
          undefined,
          tx,
        );
        const otherMentionable = runtime.getCell(
          otherSpace.did(),
          "other-mentionable-combo",
          undefined,
          tx,
        );
        const otherData: any = { type: "from-other-space" };
        otherData[NAME] = "combo-tag";
        otherMentionable.set(otherData);
        otherBacklinksIndex.set({
          mentionable: [otherMentionable],
        });
        otherDefaultPattern.set({
          backlinksIndex: otherBacklinksIndex,
        });
        (otherSpaceCell as any).key("defaultPattern").set(otherDefaultPattern);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Execute: Search with scope: ["~", otherSpace.did()]
        const wishPattern = pattern("scope tilde and did", () => {
          return {
            result: wish({
              query: "#combo-tag",
              scope: ["~", otherSpace.did()],
            }),
          };
        });

        const resultCell = runtime.getCell<{
          result?: { result?: unknown; candidates?: unknown[] };
        }>(
          patternSpace.did(),
          "scope-tilde-and-did-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        await result.pull();

        // Verify: Should find matches, favorites first
        const wishResult = result.key("result").get();
        expect(wishResult?.error).toBeUndefined();
        expect(wishResult?.result).toBeDefined();
        const resultData = (wishResult?.result as any)?.get?.() ??
          wishResult?.result;
        // Favorites match should be preferred (comes first in ordering)
        expect(resultData.type).toBe("from-favorites");
      });

      it("#default with scope: [did] returns that space's default pattern", async () => {
        // Setup: Add default pattern data to the other space
        const otherSpaceCell = runtime.getCell(
          otherSpace.did(),
          otherSpace.did(),
        ).withTx(tx);
        const otherDefaultPattern = runtime.getCell(
          otherSpace.did(),
          "other-default-for-target",
          undefined,
          tx,
        );
        otherDefaultPattern.set({
          title: "Other Space Default",
          value: "other",
        });
        (otherSpaceCell as any).key("defaultPattern").set(otherDefaultPattern);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Also set up current space with different data (separate tx for write isolation)
        const currentSpaceCell = runtime.getCell(
          patternSpace.did(),
          patternSpace.did(),
        ).withTx(tx);
        const currentDefaultPattern = runtime.getCell(
          patternSpace.did(),
          "current-default-for-target",
          undefined,
          tx,
        );
        currentDefaultPattern.set({
          title: "Current Space Default",
          value: "current",
        });
        (currentSpaceCell as any).key("defaultPattern").set(
          currentDefaultPattern,
        );

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Execute: #default with scope: [otherSpace.did()]
        const wishPattern = pattern("default with did scope", () => {
          return {
            result: wish({
              query: "#default",
              scope: [otherSpace.did()],
            }),
          };
        });

        const resultCell = runtime.getCell<{
          result?: { result?: unknown };
        }>(
          patternSpace.did(),
          "default-did-scope-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        await result.pull();

        // Verify: Should return the other space's default, not current space's
        const wishResult = result.key("result").get();
        expect(wishResult?.error).toBeUndefined();
        const defaultData = wishResult?.result;
        expect(defaultData).toBeDefined();
        expect((defaultData as any)?.title).toBe("Other Space Default");
        expect((defaultData as any)?.value).toBe("other");
      });

      it("#allPieces with scope: [did] returns that space's allPieces", async () => {
        // Setup: Add allPieces data to the other space
        const otherSpaceCell = runtime.getCell(
          otherSpace.did(),
          otherSpace.did(),
        ).withTx(tx);
        const otherDefaultPattern = runtime.getCell(
          otherSpace.did(),
          "other-default-allpieces",
          undefined,
          tx,
        );
        const otherAllPieces = runtime.getCell(
          otherSpace.did(),
          "other-allpieces-data",
          undefined,
          tx,
        );
        otherAllPieces.set([
          { name: "Piece A" },
          { name: "Piece B" },
        ]);
        otherDefaultPattern.set({
          allPieces: otherAllPieces,
        });
        (otherSpaceCell as any).key("defaultPattern").set(otherDefaultPattern);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Execute: #allPieces with scope: [otherSpace.did()]
        const wishPattern = pattern("allPieces with did scope", () => {
          return {
            result: wish({
              query: "#allPieces",
              scope: [otherSpace.did()],
            }),
          };
        });

        const resultCell = runtime.getCell<{
          result?: { result?: unknown };
        }>(
          patternSpace.did(),
          "allpieces-did-scope-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        await result.pull();

        // Verify: Should return the other space's allPieces
        const wishResult = result.key("result").get();
        expect(wishResult?.error).toBeUndefined();
        const allPieces = wishResult?.result;
        expect(allPieces).toBeDefined();
        expect(Array.isArray(allPieces)).toBe(true);
        expect((allPieces as any[])[0]?.name).toBe("Piece A");
      });

      it("error message includes space count for arbitrary DID scope", async () => {
        // Setup: Empty mentionables in other space
        const otherSpaceCell = runtime.getCell(
          otherSpace.did(),
          otherSpace.did(),
        ).withTx(tx);
        const otherDefaultPattern = runtime.getCell(
          otherSpace.did(),
          "other-default-error",
          undefined,
          tx,
        );
        otherDefaultPattern.set({
          backlinksIndex: {
            mentionable: [],
          },
        });
        (otherSpaceCell as any).key("defaultPattern").set(otherDefaultPattern);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Execute: Search with only an arbitrary DID scope, no matches
        const wishPattern = pattern("arb did error message", () => {
          return {
            result: wish({
              query: "#nonexistent",
              scope: [otherSpace.did()],
            }),
          };
        });

        const resultCell = runtime.getCell<{
          result?: { error?: string };
        }>(
          patternSpace.did(),
          "arb-did-error-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        await result.pull();

        // Verify: Error message mentions space count
        const resultData = result.key("result").get();
        expect(resultData?.error).toBeDefined();
        expect(resultData?.error).toContain("1 space(s)");
        expect(resultData?.error).not.toContain("favorites");
      });
    });

    it("deduplicates results that appear in both favorites and mentionables", async () => {
      // Setup: Create a single piece cell in pattern space
      const sharedPiece = runtime.getCell(
        patternSpace.did(),
        "shared-piece",
        undefined,
        tx,
      );
      const mentionableData: any = { type: "shared" };
      mentionableData[NAME] = "shared-tag";
      sharedPiece.set(mentionableData);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add piece to favorites in home space
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern-dedup",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      favoritesCell.set([{ cell: sharedPiece.withTx(tx), tag: "#shared-tag" }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add same piece to mentionables in pattern space
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        patternSpace.did(),
        "space-default-pattern-dedup",
        undefined,
        tx,
      );
      const backlinksIndexCell = runtime.getCell(
        patternSpace.did(),
        "backlinks-index-dedup",
        undefined,
        tx,
      );
      backlinksIndexCell.set({
        mentionable: [sharedPiece.withTx(tx)],
      });
      defaultPatternCell.set({
        backlinksIndex: backlinksIndexCell,
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Search both with scope: ["~", "."]
      const wishPattern = pattern("scope dedup test", () => {
        return { result: wish({ query: "#shared-tag", scope: ["~", "."] }) };
      });

      const resultCell = runtime.getCell<{
        result?: { result?: unknown; candidates?: unknown[] };
      }>(
        patternSpace.did(),
        "scope-dedup-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Should get a single result (deduplicated), not trigger picker
      const wishResult = result.key("result").get();
      expect(wishResult?.result).toBeDefined();
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
              "import { pattern, wish } from 'commontools';",
              "export default pattern<{}>('Compiled Wish Test', () => {",
              "  const spaceResult = wish({ query: '/' });",
              "  return { spaceResult };",
              "});",
            ].join("\n"),
          },
        ],
      };

      const compiled = await runtime.patternManager.compilePattern(program);
      const patternId = runtime.patternManager.registerPattern(compiled, program);
      const loadedPattern = await runtime.patternManager.loadPattern(
        patternId,
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
      const result = runtime.run(tx, loadedPattern, {}, resultCell);
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
              "import { pattern, wish } from 'commontools';",
              "export default pattern<{}>('Compiled Wish Path Test', () => {",
              "  const deepValue = wish({ query: '/', path: ['nested', 'deep', 'value'] });",
              "  return { deepValue };",
              "});",
            ].join("\n"),
          },
        ],
      };

      const compiled = await runtime.patternManager.compilePattern(program);
      const patternId = runtime.patternManager.registerPattern(compiled, program);
      const loadedPattern = await runtime.patternManager.loadPattern(
        patternId,
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
      const result = runtime.run(tx, loadedPattern, {}, resultCell);
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
    let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];

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
      ({ wish, pattern } = commontools);
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
      const wishPattern = pattern("wish favorites cross-space", () => {
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
      const result = runtime.run(tx, wishPattern, {}, resultCell);
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
      const wishPattern = pattern("wish default cross-space", () => {
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
      const result = runtime.run(tx, wishPattern, {}, resultCell);
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
      const wishPattern = pattern("wish mixed tags", () => {
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
      const result = runtime.run(tx, wishPattern, {}, resultCell);
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

    it("resolves hashtag using computed query (GoogleAuthManager pattern)", async () => {
      // This test mimics GoogleAuthManager which uses computed() for the wish query
      const { commontools: { computed } } = createBuilder();

      // Setup: Favorites with #googleAuth tag in home space
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const defaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = defaultPatternCell.key("favorites");
      const authItem = runtime.getCell(
        userIdentity.did(),
        "google-auth-item",
        undefined,
        tx,
      );
      authItem.set({
        auth: {
          token: "test-token",
          user: { email: "test@gmail.com" },
          scope: ["https://www.googleapis.com/auth/gmail.readonly"],
        },
      });

      favoritesCell.set([
        { cell: authItem, tag: "#googleAuth" },
      ]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Pattern uses computed() for the query - just like GoogleAuthManager
      const wishPattern = pattern("wish computed query", () => {
        const tag = computed(() => "#googleAuth");
        const authResult = wish({ query: tag });
        return { authResult };
      });

      const resultCell = runtime.getCell<{
        authResult?: { result?: unknown };
      }>(
        patternSpace.did(),
        "wish-computed-query-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Should find the auth item via hashtag search in home space
      const authResult = result.key("authResult").get();
      expect(authResult?.error).toBeUndefined();
      expect(authResult?.result).toBeDefined();
      expect((authResult?.result as any)?.auth?.user?.email).toEqual(
        "test@gmail.com",
      );
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
      const wishPattern = pattern("wish hashtag search", () => {
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
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Searches home space favorites, finds correct cell
      const taggedItem = result.key("taggedItem").get()?.result;
      expect(taggedItem).toEqual({ name: "Item with #myTag" });
    });

    it("starts piece automatically when accessed via cross-space wish", async () => {
      // Setup 1: Create a simple counter pattern/piece
      const counterPattern = pattern<{ count: number }>("counter piece", () => {
        const count = 0;
        return {
          count,
          increment: () => {
            return count + 1;
          },
        };
      });

      // Setup 2: Store the piece in home space
      const pieceCell = runtime.getCell(
        userIdentity.did(),
        "counter-piece",
        undefined,
        tx,
      );
      // Setup the piece (but don't start it yet)
      runtime.setup(tx, counterPattern, {}, pieceCell);

      // Setup 3: Add piece to favorites through defaultPattern
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const defaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = defaultPatternCell.key("favorites");
      favoritesCell.set([
        { cell: pieceCell, tag: "#counterPiece test piece" },
      ]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Pattern in different space wishes for the piece via hashtag
      const wishingPattern = pattern("wish for piece", () => {
        return { pieceData: wish({ query: "#counterPiece" }) };
      });

      const resultCell = runtime.getCell<{
        pieceData?: { result?: unknown };
      }>(
        patternSpace.did(),
        "wish-piece-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishingPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Wish triggered piece to start and returns running piece data
      const pieceData = result.key("pieceData").get()?.result;
      expect(pieceData).toBeDefined();
      expect(typeof pieceData).toBe("object");

      // The piece should be running and have its state accessible
      // Note: This test may need adjustment based on actual piece startup behavior
      if (typeof pieceData === "object" && pieceData !== null) {
        expect("count" in pieceData || "increment" in pieceData).toBe(true);
      }
    });
  });
});

describe("parseWishTarget", () => {
  it("parses absolute paths starting with /", () => {
    const result = parseWishTarget("/allPieces");
    expect(result).toEqual({ key: "/", path: ["allPieces"] });
  });

  it("parses nested absolute paths", () => {
    const result = parseWishTarget("/allPieces/0/title");
    expect(result).toEqual({ key: "/", path: ["allPieces", "0", "title"] });
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
    const result = parseWishTarget("  /allPieces  ");
    expect(result).toEqual({ key: "/", path: ["allPieces"] });
  });

  it("filters empty segments", () => {
    const result = parseWishTarget("/allPieces//nested/");
    expect(result).toEqual({ key: "/", path: ["allPieces", "nested"] });
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

describe("tagMatchesHashtag", () => {
  it("matches exact hashtag in tag string", () => {
    expect(tagMatchesHashtag("#todo items", "todo")).toBe(true);
  });

  it("does not match partial hashtag", () => {
    expect(tagMatchesHashtag("#todolist", "todo")).toBe(false);
  });

  it("matches among multiple hashtags", () => {
    expect(tagMatchesHashtag("some #alpha and #beta text", "beta")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(tagMatchesHashtag("#Todo", "todo")).toBe(true);
  });

  it("returns false for undefined tag", () => {
    expect(tagMatchesHashtag(undefined, "todo")).toBe(false);
  });

  it("returns false for empty tag", () => {
    expect(tagMatchesHashtag("", "todo")).toBe(false);
  });

  it("ignores non-hashtag text", () => {
    expect(tagMatchesHashtag("todo without hash", "todo")).toBe(false);
  });

  it("matches hashtag at start of string", () => {
    expect(tagMatchesHashtag("#pattern for dinner", "pattern")).toBe(true);
  });

  it("matches hashtag portion before special characters", () => {
    // The hashtag #todo_list is parsed as #todo (underscore ends the hashtag)
    expect(tagMatchesHashtag("#todo_list", "todo")).toBe(true);
    expect(tagMatchesHashtag("#todo_list", "todo_list")).toBe(false);
  });
});
