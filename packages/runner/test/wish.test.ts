import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { entityIdFrom } from "../src/create-ref.ts";
import { NAME, UI } from "../src/builder/types.ts";
import {
  createSidecarPatternCache,
  parseWishTarget,
  tagMatchesHashtag,
} from "../src/builtins/wish.ts";
import {
  getPatternEnvironment,
  setPatternEnvironment,
} from "../src/builder/env.ts";

const signer = await Identity.fromPassphrase("wish built-in tests");
const space = signer.did();

// Stable entity id used to address the test's "all pieces" cell. The value is
// opaque to these tests, which set up the cell and the space link to it
// directly; it's a real content-hash id so it stays well-formed.
const allPiecesEntityId = entityIdFrom(hashOf("all-pieces"));
const allPiecesId = allPiecesEntityId.taggedHashString;

describe("wish built-in", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: ReturnType<Runtime["edit"]>;
  let wish: ReturnType<typeof createBuilder>["commonfabric"]["wish"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ wish, pattern } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  it("resolves the well known all pieces cell", async () => {
    const allPiecesCell = runtime.getCellFromEntityId<unknown[]>(
      space,
      allPiecesEntityId,
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

    const wishPattern = pattern(() => {
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
    expect(linkData?.id).toEqual(`of:${allPiecesId}`);
  });

  it("resolves semantic wishes with # prefixes", async () => {
    const allPiecesCell = runtime.getCellFromEntityId(
      space,
      allPiecesEntityId,
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

    const wishPattern = pattern(() => {
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

    const wishPattern = pattern(() => {
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

    const wishPattern = pattern(() => {
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

    const wishPattern = pattern(() => {
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
    const wishPattern = pattern(() => {
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

    const wishPattern = pattern(() => {
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

    const wishPattern = pattern(() => {
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
    const wishPattern = pattern(() => {
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
        allPiecesEntityId,
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

      const wishPattern = pattern(() => {
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

      await runtime.idle();
      await result.pull();

      expect(result.key("allPieces").get()?.result).toEqual(piecesData);
    });

    it("resolves nested paths using tag and path parameters", async () => {
      const allPiecesCell = runtime.getCellFromEntityId<unknown[]>(
        space,
        allPiecesEntityId,
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

      const wishPattern = pattern(() => {
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

      await runtime.idle();
      await result.pull();

      expect(result.key("firstTitle").get()?.result).toEqual("First Title");
    });

    it("resolves slashed path embedded in tag query", async () => {
      const allPiecesCell = runtime.getCellFromEntityId<unknown[]>(
        space,
        allPiecesEntityId,
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

      const wishPattern = pattern(() => {
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

      await runtime.idle();
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

      const wishPattern = pattern(() => {
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

      await runtime.idle();
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

      const wishPattern = pattern(() => {
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
      const wishPattern = pattern(() => {
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
      const wishPattern = pattern(() => {
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
      const wishPattern = pattern(() => {
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

    it("returns cell UI or cf-cell-link fallback on success", async () => {
      const spaceCell = runtime.getCell(space, space).withTx(tx);
      const spaceData = { testField: "space cell value" };
      spaceCell.set(spaceData);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
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

      // Plain data has no [UI], so falls back to cf-cell-link
      const ui = wishResult?.[UI] as { type: string; name: string; props: any };
      expect(ui?.type).toEqual("vnode");
      expect(ui?.name).toEqual("cf-cell-link");
      expect(ui?.props?.$cell).toBeDefined();
    });

    it("returns UI with error message on failure", async () => {
      const errors: unknown[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args);
      };

      try {
        const wishPattern = pattern(() => {
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

      const wishPattern = pattern(() => {
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
    let wish: ReturnType<typeof createBuilder>["commonfabric"]["wish"];
    let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

    beforeEach(async () => {
      userIdentity = await Identity.fromPassphrase("scope-test-user");
      patternSpace = await Identity.fromPassphrase("scope-pattern-space");
      storageManager = StorageManager.emulate({ as: userIdentity });
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      tx = runtime.edit();

      const { commonfabric } = createTrustedBuilder(runtime);
      ({ wish, pattern } = commonfabric);
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
      favoritesCell.set([{ cell: favoriteItem, tags: ["test-tag"] }]);
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
      const wishPattern = pattern(() => {
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
      favoritesCell.set([{ cell: favoriteItem, tags: ["test-tag"] }]);
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
      const wishPattern = pattern(() => {
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

    it("matches favorites by structured tags", async () => {
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern-structured",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item-structured",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      favoritesCell.set([{ cell: favoriteItem, tags: ["structured-tag"] }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        return { result: wish({ query: "#structured-tag", scope: ["~"] }) };
      });
      const resultCell = runtime.getCell<{ result?: { result?: unknown } }>(
        patternSpace.did(),
        "structured-tags-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();
      await result.pull();

      const data = (() => {
        const r = result.key("result").get()?.result;
        return (r as any)?.get?.() ?? r;
      })();
      expect(data?.type).toBe("favorite");
    });

    it("matches favorites by user tags", async () => {
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern-usertags",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item-usertags",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      // No schema-derived tags; only a user-applied tag should match.
      favoritesCell.set([{ cell: favoriteItem, tags: [], userTags: ["mine"] }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        return { result: wish({ query: "#mine", scope: ["~"] }) };
      });
      const resultCell = runtime.getCell<{ result?: { result?: unknown } }>(
        patternSpace.did(),
        "favorites-usertags-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();
      await result.pull();

      const r = result.key("result").get()?.result;
      const data = (r as any)?.get?.() ?? r;
      expect(data?.type).toBe("favorite");
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
      favoritesCell.set([{ cell: favoriteItem, tags: ["fav-tag"] }]);
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
      const wishPattern1 = pattern(() => {
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
      const wishPattern2 = pattern(() => {
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
      favoritesCell.set([{ cell: favoriteItem, tags: ["test-tag"] }]);
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
      const wishPattern = pattern(() => {
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
      const wishPattern = pattern(() => {
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
      favoritesCell.set([{ cell: favoriteItem, tags: ["test-tag"] }]);
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
      const wishPattern = pattern(() => {
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
      const wishPattern = pattern(() => {
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
        const wishPattern = pattern(() => {
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
        await runtime.storageManager.synced();
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
        await runtime.storageManager.synced();
        await runtime.idle();
        tx = runtime.edit();

        // Execute: Search with scope: [".", otherSpace.did()]
        const wishPattern = pattern(() => {
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
        await runtime.idle();
        await runtime.storageManager.synced();
        await runtime.idle();
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
        favoritesCell.set([{ cell: favoriteItem, tags: ["combo-tag"] }]);
        (homeSpaceCell as any).key("defaultPattern").set(
          homeDefaultPatternCell,
        );

        await tx.commit();
        await runtime.storageManager.synced();
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
        await runtime.storageManager.synced();
        await runtime.idle();
        tx = runtime.edit();

        // Execute: Search with scope: ["~", otherSpace.did()]
        const wishPattern = pattern(() => {
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
        await runtime.idle();
        await runtime.storageManager.synced();
        await runtime.idle();
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
        const wishPattern = pattern(() => {
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
        const wishPattern = pattern(() => {
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
        const wishPattern = pattern(() => {
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
      favoritesCell.set([{
        cell: sharedPiece.withTx(tx),
        tags: ["shared-tag"],
      }]);
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
      const wishPattern = pattern(() => {
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
              "import { pattern, wish } from 'commonfabric';",
              "export default pattern<{}>(() => {",
              "  const spaceResult = wish({ query: '/' });",
              "  return { spaceResult };",
              "});",
            ].join("\n"),
          },
        ],
      };

      const loadedPattern = await runtime.patternManager.compilePattern(
        program,
        { space },
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
              "import { pattern, wish } from 'commonfabric';",
              "export default pattern<{}>(() => {",
              "  const deepValue = wish({ query: '/', path: ['nested', 'deep', 'value'] });",
              "  return { deepValue };",
              "});",
            ].join("\n"),
          },
        ],
      };

      const loadedPattern = await runtime.patternManager.compilePattern(
        program,
        { space },
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
    let wish: ReturnType<typeof createBuilder>["commonfabric"]["wish"];
    let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

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

      const { commonfabric } = createTrustedBuilder(runtime);
      ({ wish, pattern } = commonfabric);
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
      const wishPattern = pattern(() => {
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

    async function resolveFavoritesTerm(
      label: string,
      entry: { tags?: string[]; userTags?: string[] },
      term: string,
      options?: { value?: unknown; path?: string[] },
    ) {
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const defaultPatternCell = runtime.getCell(
        userIdentity.did(),
        `default-pattern-${label}`,
        undefined,
        tx,
      );
      const favoritesCell = defaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        `favorite-item-${label}`,
        undefined,
        tx,
      );
      favoriteItem.set(options?.value ?? { name: "My Favorite", value: 42 });
      favoritesCell.set([
        {
          cell: favoriteItem,
          tags: entry.tags ?? [],
          userTags: entry.userTags ?? [],
        },
      ]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        return {
          result: wish({
            query: ["#favorites", term, ...(options?.path ?? [])].join("/"),
          }),
        };
      });
      const resultCell = runtime.getCell<{
        result?: { result?: unknown; error?: string };
      }>(
        patternSpace.did(),
        `favorites-term-${label}-result`,
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();
      await result.pull();
      return result.key("result").get();
    }

    it("matches a #favorites/<term> query by a structured discovery tag", async () => {
      const resolved = await resolveFavoritesTerm(
        "tag",
        { tags: ["weather"] },
        "weather",
      );
      expect(resolved?.error).toBeUndefined();
    });

    it("matches a #favorites/<term> query by a user tag substring", async () => {
      const resolved = await resolveFavoritesTerm(
        "usertag",
        { userTags: ["mynotebook"] },
        "note",
      );
      expect(resolved?.error).toBeUndefined();
    });

    it("resolves #favorites/<term> to the matched favorite", async () => {
      const resolved = await resolveFavoritesTerm(
        "weather-value",
        { userTags: ["weather"] },
        "weather",
        { value: { name: "My Favorite", value: 42 } },
      );
      expect(resolved?.result).toEqual({
        name: "My Favorite",
        value: 42,
      });
    });

    it("resolves #favorites/<term>/<subpath> inside the matched favorite", async () => {
      const resolved = await resolveFavoritesTerm(
        "weather-subpath",
        { userTags: ["weather"] },
        "weather",
        {
          value: { name: "My Favorite", forecast: { temp: 72 } },
          path: ["forecast", "temp"],
        },
      );
      expect(resolved?.result).toBe(72);
    });

    it("reports an error for #favorites/<term> when nothing matches", async () => {
      const resolved = await resolveFavoritesTerm(
        "nomatch",
        { tags: ["weather"], userTags: ["mine"] },
        "missing",
      );
      expect(resolved?.result).toBeUndefined();
      expect(resolved?.error).toMatch(/No favorite found matching/);
    });

    async function resolveHomeTarget(
      label: string,
      key: string,
      value: unknown,
      query: string,
    ) {
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const defaultPatternCell = runtime.getCell(
        userIdentity.did(),
        `default-pattern-${label}`,
        undefined,
        tx,
      );
      defaultPatternCell.key(key).set(value);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        return { result: wish({ query }) };
      });
      const resultCell = runtime.getCell<{ result?: { result?: unknown } }>(
        patternSpace.did(),
        `home-target-${label}-result`,
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();
      await result.pull();
      return result.key("result").get();
    }

    it("resolves #journal to the home journal list", async () => {
      const resolved = await resolveHomeTarget(
        "journal",
        "journal",
        [{ narrative: "first entry" }],
        "#journal",
      );
      expect(resolved?.error).toBeUndefined();
      const journal = resolved?.result;
      expect(Array.isArray(journal)).toBe(true);
      expect((journal as any[])[0].narrative).toBe("first entry");
    });

    it("resolves #learned to the home learned object", async () => {
      const resolved = await resolveHomeTarget(
        "learned",
        "learned",
        { summary: "a learned summary" },
        "#learned",
      );
      expect(resolved?.error).toBeUndefined();
      expect((resolved?.result as any)?.summary).toBe("a learned summary");
    });

    it("resolves #learnedSummary to the home learned summary", async () => {
      const resolved = await resolveHomeTarget(
        "learned-summary",
        "learned",
        { summary: "Known facts" },
        "#learnedSummary",
      );
      expect(resolved?.error).toBeUndefined();
      expect(resolved?.result).toBe("Known facts");
    });

    it("resolves well-known profile targets from the home default profile link", async () => {
      const profileSpaceDid = (await Identity.fromPassphrase(
        "wish-profile-space",
      )).did();
      const profileSpaceCell = runtime.getSpaceCell(
        profileSpaceDid,
        undefined,
        tx,
      );
      const profileDefaultCell = runtime.getCell(
        profileSpaceDid,
        "profile-default",
        undefined,
        tx,
      );
      profileDefaultCell.set({
        name: "Ada Lovelace",
        initialNameApplied: "Ada Lovelace",
        avatar: "ada.png",
        bio: "Mathematician & first programmer.",
        elements: [],
      });
      profileSpaceCell.key("defaultPattern").set(profileDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-profile-link",
        undefined,
        tx,
      );
      homeDefaultCell.key("profiles").set([profileDefaultCell]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        return {
          profile: wish({ query: "#profile" }),
          profileName: wish({ query: "#profileName" }),
          profileAvatar: wish({ query: "#profileAvatar" }),
          profileBio: wish({ query: "#profileBio" }),
          profileSpace: wish({ query: "#profileSpace" }),
        };
      });

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-profile-targets-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("profile").get()?.result?.name).toBe("Ada Lovelace");
      expect(result.key("profileName").get()?.result).toBe("Ada Lovelace");
      expect(result.key("profileAvatar").get()?.result).toBe("ada.png");
      expect(result.key("profileBio").get()?.result).toBe(
        "Mathematician & first programmer.",
      );
      expect(result.key("profileSpace").get()?.result?.defaultPattern?.name)
        .toBe("Ada Lovelace");
    });

    it("#profile resolves to the default directly (no picker) when a default is set among multiple profiles", async () => {
      // Regression for the profile-picker deadlock: a non-headless `#profile`
      // wish from a viewer with 2+ profiles used to launch the multi-candidate
      // picker, leaving `.result` undefined until a selection — dead-locking
      // every pattern that wishes for "the viewer's active profile" (e.g.
      // profile-group-chat's send guard). With a default set, `#profile` must
      // resolve to it directly as a single result.
      const profileSpaceDid = (await Identity.fromPassphrase(
        "wish-profile-default-among-many",
      )).did();
      const profileA = runtime.getCell(
        profileSpaceDid,
        "profile-a",
        undefined,
        tx,
      );
      profileA.set({
        name: "Default Della",
        initialNameApplied: "Default Della",
        avatar: "della.png",
        bio: "",
        elements: [],
      });
      const profileB = runtime.getCell(
        profileSpaceDid,
        "profile-b",
        undefined,
        tx,
      );
      profileB.set({
        name: "Other Otto",
        initialNameApplied: "Other Otto",
        avatar: "otto.png",
        bio: "",
        elements: [],
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-among-many",
        undefined,
        tx,
      );
      homeDefaultCell.key("profiles").set([profileA, profileB]);
      homeDefaultCell.key("defaultProfile").set(profileA);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        return { profile: wish({ query: "#profile" }) };
      });

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-default-among-many-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Single, direct result — the default — not the picker (which would leave
      // `.result` undefined until a selection).
      expect(result.key("profile").get()?.result?.name).toBe("Default Della");
    });

    it("#profileDefault is not a well-known profile target", async () => {
      const profileSpaceDid = (await Identity.fromPassphrase(
        "wish-profile-default-removed-space",
      )).did();
      const profileDefaultCell = runtime.getCell(
        profileSpaceDid,
        "profile-default-removed",
        undefined,
        tx,
      );
      profileDefaultCell.set({
        name: "Ada Lovelace",
        initialNameApplied: "Ada Lovelace",
        avatar: "ada.png",
        elements: [],
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-profile-default-removed",
        undefined,
        tx,
      );
      homeDefaultCell.key("profiles").set([profileDefaultCell]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => ({
        profileDefault: wish({ query: "#profileDefault" }),
      }));

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-profile-default-removed-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("profileDefault").get()?.result).toBeUndefined();
      expect(String(result.key("profileDefault").get()?.error)).toContain(
        "#profiledefault",
      );
    });

    it("renders #profile wish UI as a link when the profile exists", async () => {
      const profileSpaceDid = (await Identity.fromPassphrase(
        "wish-profile-ui-space",
      )).did();
      const profileDefaultCell = runtime.getCell(
        profileSpaceDid,
        "profile-ui-default",
        undefined,
        tx,
      );
      profileDefaultCell.set({
        name: "Ada Lovelace",
        initialNameApplied: "Ada Lovelace",
        avatar: "ada.png",
        elements: [],
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-profile-ui-link",
        undefined,
        tx,
      );
      homeDefaultCell.key("profiles").set([profileDefaultCell]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => ({
        profile: wish({ query: "#profile" }),
      }));

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-profile-ui-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const ui = result.key("profile").key(UI).get() as any;
      expect(ui?.name).toBe("cf-cell-link");
      expect(
        result.key("profile").key(UI).key("props").key("$cell")
          .resolveAsCell()
          .get()?.name,
      ).toBe("Ada Lovelace");
    });

    it("renders #profile wish UI as a create-profile input when the profile is missing", async () => {
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-profile-create-ui",
        undefined,
        tx,
      );
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => ({
        profile: wish({ query: "#profile" }),
      }));

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-missing-profile-ui-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const state = result.key("profile").get();
      const ui = result.key("profile").key(UI).get() as any;
      expect(state?.result).toBeUndefined();
      expect(String(state?.error)).toContain("profile");
      expect(ui?.name).toBe("cf-render");
      expect(ui?.props?.["data-profile-create-ui"]).toBe("wish");
      expect(
        result.key("profile").key(UI).key("props").key("$cell")
          .resolveAsCell()
          .getRaw(),
      ).toBeUndefined();
    });

    it("fetches the profile-create pattern from the pattern environment apiUrl set after module load", async () => {
      // Regression test: the sidecar pattern URLs (profile-create / picker /
      // suggestion) must be resolved when the fetch happens, not at module
      // import. In the browser worker, wish.ts is imported before the runtime
      // calls setPatternEnvironment with the real API URL; a module-load-time
      // const captures the default (the worker's own origin, i.e. the frontend
      // server), whose SPA fallback serves index.html instead of the pattern.
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-profile-create-fetch-url",
        undefined,
        tx,
      );
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const recordedUrls: string[] = [];
      const originalFetch = globalThis.fetch;
      const originalEnvironment = getPatternEnvironment();
      setPatternEnvironment({ apiUrl: new URL("https://pattern-env.test/") });
      globalThis.fetch = ((input: Request | URL | string) => {
        recordedUrls.push(
          input instanceof Request ? input.url : String(input),
        );
        return Promise.resolve(new Response("not found", { status: 404 }));
      }) as typeof fetch;

      try {
        const wishPattern = pattern(() => ({
          profile: wish({ query: "#profile" }),
        }));
        const resultCell = runtime.getCell<Record<string, any>>(
          patternSpace.did(),
          "wish-profile-create-fetch-url-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        await result.pull();

        // The missing-profile UI kicks off a deferred profile-create fetch.
        const expectedUrl =
          "https://pattern-env.test/api/patterns/system/profile-create.tsx";
        const deadline = Date.now() + 5_000;
        while (
          !recordedUrls.includes(expectedUrl) && Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(recordedUrls).toContain(expectedUrl);
      } finally {
        globalThis.fetch = originalFetch;
        setPatternEnvironment(originalEnvironment);
        await runtime.idle();
      }
    });

    it("searches home default profile elements for hashtag wishes with profile scope", async () => {
      const profileSpaceDid = (await Identity.fromPassphrase(
        "wish-profile-hashtag-space",
      )).did();
      const profileDefaultCell = runtime.getCell(
        profileSpaceDid,
        "profile-default-hashtag",
        undefined,
        tx,
      );
      const profileCard = runtime.getCell(
        profileSpaceDid,
        "profile-card",
        undefined,
        tx,
      );
      profileCard.set({ title: "Profile Card", kind: "card" });
      profileDefaultCell.set({
        name: "Ada",
        initialNameApplied: "Ada",
        avatar: "",
        elements: [{
          cell: profileCard,
          tag: "#profileCard",
          userTags: ["person"],
          title: "Profile Card",
        }],
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-profile-hashtag-link",
        undefined,
        tx,
      );
      homeDefaultCell.key("profiles").set([profileDefaultCell]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => ({
        byUserTag: wish({ query: "#person", scope: ["profile"] }),
        byTag: wish({ query: "#profileCard", scope: ["profile"] }),
      }));

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-profile-hashtag-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("byUserTag").get()?.result?.title).toBe(
        "Profile Card",
      );
      expect(result.key("byTag").get()?.result?.kind).toBe("card");
    });

    it("resolves headless #profile to the default profile (ordered first)", async () => {
      // Both profiles live in one (non-home) space so the home write opens a
      // single cross-space writer; the real create flow appends one space per
      // transaction.
      const profileSpaceDid = (await Identity.fromPassphrase(
        "wish-multi-profile-space",
      )).did();
      const p1 = runtime.getCell(
        profileSpaceDid,
        "multi-profile-1",
        undefined,
        tx,
      );
      p1.set({
        name: "Ada",
        initialNameApplied: "Ada",
        avatar: "ada.png",
        elements: [],
      });
      const p2 = runtime.getCell(
        profileSpaceDid,
        "multi-profile-2",
        undefined,
        tx,
      );
      p2.set({
        name: "Grace",
        initialNameApplied: "Grace",
        avatar: "grace.png",
        elements: [],
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-multi-profile-default-link",
        undefined,
        tx,
      );
      // Two profiles; the default is the *second* one — it must still resolve
      // first for headless callers.
      homeDefaultCell.key("profiles").set([p1, p2]);
      homeDefaultCell.key("defaultProfile").set(p2);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => ({
        profile: wish({ query: "#profile", headless: true }),
        profileName: wish({ query: "#profileName" }),
        profileAvatar: wish({ query: "#profileAvatar" }),
      }));
      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-multi-profile-default-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();
      await result.pull();

      expect(result.key("profile").get()?.result?.name).toBe("Grace");
      expect(result.key("profileName").get()?.result).toBe("Grace");
      expect(result.key("profileAvatar").get()?.result).toBe("grace.png");
    });

    it("orders headless #profile by MRU when no default is set", async () => {
      const profileSpaceDid = (await Identity.fromPassphrase(
        "wish-mru-profile-space",
      )).did();
      const p1 = runtime.getCell(
        profileSpaceDid,
        "mru-profile-1",
        undefined,
        tx,
      );
      p1.set({
        name: "Ada",
        initialNameApplied: "Ada",
        avatar: "",
        elements: [],
      });
      const p2 = runtime.getCell(
        profileSpaceDid,
        "mru-profile-2",
        undefined,
        tx,
      );
      p2.set({
        name: "Grace",
        initialNameApplied: "Grace",
        avatar: "",
        elements: [],
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-mru-profile-link",
        undefined,
        tx,
      );
      // No default set; MRU lists p2 first, so p2 must resolve first.
      homeDefaultCell.key("profiles").set([p1, p2]);
      homeDefaultCell.key("mru").set([p2]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => ({
        profile: wish({ query: "#profile", headless: true }),
      }));
      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-mru-profile-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();
      await result.pull();

      expect(result.key("profile").get()?.result?.name).toBe("Grace");
    });

    it("does not parse profile scope as an arbitrary DID", async () => {
      const wishPattern = pattern(() => ({
        missing: wish({ query: "#missing", scope: ["profile"] }),
      }));

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-profile-scope-reserved-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const state = result.key("missing").get();
      expect(state?.result).toBeUndefined();
      expect(String(state?.error)).toContain("profile");
      expect(String(state?.error)).not.toContain("did");
    });

    it("returns an error state instead of throwing when profile space is missing", async () => {
      const wishPattern = pattern(() => ({
        profileName: wish({ query: "#profileName" }),
      }));

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-missing-profile-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const state = result.key("profileName").get();
      expect(state?.result).toBeUndefined();
      expect(String(state?.error)).toContain("profile");
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
      const wishPattern = pattern(() => {
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
      const wishPattern = pattern(() => {
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
      const { commonfabric: { computed } } = createTrustedBuilder(runtime);

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
        { cell: authItem, tags: ["googleauth"] },
      ]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Pattern uses computed() for the query - just like GoogleAuthManager
      const wishPattern = pattern(() => {
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
        { cell: favoriteItem1, tags: ["mytag", "awesome"] },
        { cell: favoriteItem2, tags: [] },
      ]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Pattern in different space wishes for #myTag
      const wishPattern = pattern(() => {
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
      // Setup 1: Create a simple piece. The actual returned shape doesn't
      // matter for this test — we only care that the piece can be started
      // and that its result is reachable through a cross-space wish.
      const counterPattern = pattern<{ count: number }>(() => {
        const count = 0;
        return { count };
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
        { cell: pieceCell, tags: ["counterpiece"] },
      ]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Pattern in different space wishes for the piece via hashtag
      const wishingPattern = pattern(() => {
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

      // The piece should be running and have its state accessible.
      if (typeof pieceData === "object" && pieceData !== null) {
        expect("count" in pieceData).toBe(true);
      }
    });

    // CT-1829: `wish("#profile").result` is ALWAYS the single best profile
    // (ordered default → MRU → first) in every mode. The picker no longer owns
    // `.result`; it is only the `[UI]` switching affordance. These tests pin the
    // decided contract that Loom (loom PR #3627) binds to. This is a distinct
    // describe from the "host embedding contract" block landing in PR #4502 — do
    // not depend on that one.
    describe("single-result #profile contract (CT-1829)", () => {
      // Stand up N profiles in one profile space, wire the home default-pattern
      // `profiles` list (and optionally `defaultProfile` / `mru`), run a
      // `#profile` wish (interactive unless `headless`), and return the wish
      // state cell so callers can read `.result` / `[UI]` and re-pull after
      // writes.
      async function setupProfiles(
        label: string,
        opts: {
          names: string[];
          defaultIndex?: number;
          // Indices into `names`, most-recently-used first.
          mruIndices?: number[];
          // Point `defaultProfile` at a cell that is not in `profiles` (an
          // invalid default link) so `defaultValid` is false.
          invalidDefault?: boolean;
          headless?: boolean;
        },
      ) {
        const profileSpaceDid = (await Identity.fromPassphrase(
          `ct1829-${label}-space`,
        )).did();
        const profileCells = opts.names.map((name, i) => {
          const cell = runtime.getCell(
            profileSpaceDid,
            `ct1829-${label}-profile-${i}`,
            undefined,
            tx,
          );
          cell.set({
            name,
            initialNameApplied: name,
            avatar: "",
            bio: "",
            elements: [],
          });
          return cell;
        });

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        const homeSpaceCell = runtime.getHomeSpaceCell(tx);
        const homeDefaultCell = runtime.getCell(
          userIdentity.did(),
          `ct1829-${label}-home-default`,
          undefined,
          tx,
        );
        homeDefaultCell.key("profiles").set(profileCells);
        if (opts.invalidDefault) {
          // An invalid default link: points at a cell in the HOME space, which
          // profileCellIsValid rejects (it requires the profile live in a
          // non-home space). So `defaultValid` is false and the default is
          // ignored — the next ordering rule (MRU) applies.
          const orphan = runtime.getCell(
            userIdentity.did(),
            `ct1829-${label}-orphan-default`,
            undefined,
            tx,
          );
          orphan.set({
            name: "Orphan",
            initialNameApplied: "Orphan",
            avatar: "",
            bio: "",
            elements: [],
          });
          homeDefaultCell.key("defaultProfile").set(orphan);
        } else if (opts.defaultIndex !== undefined) {
          homeDefaultCell.key("defaultProfile").set(
            profileCells[opts.defaultIndex],
          );
        }
        if (opts.mruIndices) {
          homeDefaultCell.key("mru").set(
            opts.mruIndices.map((i) => profileCells[i]),
          );
        }
        (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        const wishPattern = pattern(() => ({
          profile: wish(
            opts.headless
              ? { query: "#profile", headless: true }
              : { query: "#profile" },
          ),
        }));
        const resultCell = runtime.getCell<Record<string, any>>(
          patternSpace.did(),
          `ct1829-${label}-result`,
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();
        await result.pull();

        return { result, homeDefaultCell, profileCells };
      }

      it("0 profiles → result undefined, error set, create-surface UI", async () => {
        const homeSpaceCell = runtime.getHomeSpaceCell(tx);
        const homeDefaultCell = runtime.getCell(
          userIdentity.did(),
          "ct1829-zero-home-default",
          undefined,
          tx,
        );
        (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);
        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        const wishPattern = pattern(() => ({
          profile: wish({ query: "#profile" }),
        }));
        const resultCell = runtime.getCell<Record<string, any>>(
          patternSpace.did(),
          "ct1829-zero-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();
        await result.pull();

        const state = result.key("profile").get();
        const ui = result.key("profile").key(UI).get() as any;
        expect(state?.result).toBeUndefined();
        expect(String(state?.error)).toContain("profile");
        expect(ui?.props?.["data-profile-create-ui"]).toBe("wish");
      });

      it("1 profile → result = it (interactive)", async () => {
        const { result } = await setupProfiles("one-interactive", {
          names: ["Solo"],
        });
        expect(result.key("profile").get()?.result?.name).toBe("Solo");
      });

      it("1 profile → result = it (headless)", async () => {
        const { result } = await setupProfiles("one-headless", {
          names: ["Solo"],
          headless: true,
        });
        expect(result.key("profile").get()?.result?.name).toBe("Solo");
      });

      it("2+ with valid default → result = default (interactive)", async () => {
        const { result } = await setupProfiles("default-interactive", {
          names: ["First", "TheDefault"],
          defaultIndex: 1,
        });
        expect(result.key("profile").get()?.result?.name).toBe("TheDefault");
      });

      it("2+ with valid default → result = default (headless)", async () => {
        const { result } = await setupProfiles("default-headless", {
          names: ["First", "TheDefault"],
          defaultIndex: 1,
          headless: true,
        });
        expect(result.key("profile").get()?.result?.name).toBe("TheDefault");
      });

      it("2+ no default → result = MRU head, INTERACTIVE (new behavior; no empty window)", async () => {
        // The orphan-second-profile case: 2 profiles, no default, MRU lists the
        // second first. Pre-CT-1829 this launched the picker and left `.result`
        // undefined until the sidecar ran (undefined forever on fetch failure —
        // which is exactly what happens here, the sidecar 404s against the test
        // apiUrl). Now `.result` rides the main wish state and resolves eagerly.
        const { result } = await setupProfiles("mru-interactive", {
          names: ["Ada", "Grace"],
          mruIndices: [1],
        });
        expect(result.key("profile").get()?.result?.name).toBe("Grace");
      });

      it("2+ no default → result = MRU head (headless)", async () => {
        const { result } = await setupProfiles("mru-headless", {
          names: ["Ada", "Grace"],
          mruIndices: [1],
          headless: true,
        });
        expect(result.key("profile").get()?.result?.name).toBe("Grace");
      });

      it("2+ no default, no MRU → result = first (interactive)", async () => {
        const { result } = await setupProfiles("first-interactive", {
          names: ["Ada", "Grace"],
        });
        expect(result.key("profile").get()?.result?.name).toBe("Ada");
      });

      it("2+ no default, no MRU → result = first (headless)", async () => {
        const { result } = await setupProfiles("first-headless", {
          names: ["Ada", "Grace"],
          headless: true,
        });
        expect(result.key("profile").get()?.result?.name).toBe("Ada");
      });

      it("invalid default link → skipped, next rule (MRU) applies", async () => {
        // defaultProfile points at a cell not in `profiles` → defaultValid is
        // false, so the default is ignored and MRU order wins.
        const { result } = await setupProfiles("invalid-default", {
          names: ["Ada", "Grace"],
          invalidDefault: true,
          mruIndices: [1],
        });
        expect(result.key("profile").get()?.result?.name).toBe("Grace");
      });

      it("interactive 2+ no default renders the picker sidecar as [UI]", async () => {
        const { result } = await setupProfiles("picker-ui", {
          names: ["Ada", "Grace"],
        });
        const ui = result.key("profile").key(UI).get() as any;
        expect(ui?.name).toBe("cf-render");
        expect(ui?.props?.["data-profile-picker-ui"]).toBe("wish");
        // And `.result` is populated even though the sidecar has not run.
        expect(result.key("profile").get()?.result?.name).toBe("Ada");
      });

      it("MRU write flips result (the switcher contract: selection = MRU write → result changes)", async () => {
        // Start with Ada as most-recently-used (no default) → result = Ada.
        const { result, profileCells } = await setupProfiles(
          "mru-flip",
          { names: ["Ada", "Grace"], mruIndices: [0] },
        );
        expect(result.key("profile").get()?.result?.name).toBe("Ada");

        // Simulate the picker's "Use" action: stamp Grace as most-recently-used.
        // This is the trusted picker-surface write the switcher makes — it feeds
        // the same MRU ordering the builtin reads, so `.result` (ordered[0])
        // tracks the selection rather than the picker's confirm gesture.
        const liveMru = runtime.getHomeSpaceCell(tx)
          .key("defaultPattern")
          .resolveAsCell()
          .key("mru") as any;
        liveMru.set([profileCells[1].withTx(tx)]);
        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Resolve `#profile` after the selection write: ordered[0] — and thus
        // `.result` — now follows the new MRU head. (A live picker sidecar drives
        // this reactively through the scheduler graph; here we re-resolve to
        // assert the ordering contract the write feeds.)
        const wishPattern2 = pattern(() => ({
          profile: wish({ query: "#profile" }),
        }));
        const rc2 = runtime.getCell<Record<string, any>>(
          patternSpace.did(),
          "ct1829-mru-flip-after-selection",
          undefined,
          tx,
        );
        const r2 = runtime.run(tx, wishPattern2, {}, rc2);
        await tx.commit();
        tx = runtime.edit();
        await r2.pull();

        expect(r2.key("profile").get()?.result?.name).toBe("Grace");
      });

      it("picker sidecar fetch failure → result still resolves; error surfaced in picker UI", async () => {
        // Point the pattern environment at a host whose fetch fails, so the
        // picker sidecar fetch rejects/404s. Under CT-1829 `.result` no longer
        // rides the sidecar cell, so it must still resolve to ordered[0]; the
        // fetch failure is surfaced as an error inside the picker `[UI]` cell,
        // not as an unhandled rejection.
        const originalFetch = globalThis.fetch;
        const originalEnvironment = getPatternEnvironment();
        setPatternEnvironment({
          apiUrl: new URL("https://ct1829-picker-fail.test/"),
        });
        globalThis.fetch = ((input: Request | URL | string) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.includes("profile-picker.tsx")) {
            return Promise.reject(new Error("picker fetch boom"));
          }
          return Promise.resolve(new Response("not found", { status: 404 }));
        }) as typeof fetch;

        try {
          const { result } = await setupProfiles("picker-fail", {
            names: ["Ada", "Grace"],
          });
          // `.result` still resolves to the single best profile.
          expect(result.key("profile").get()?.result?.name).toBe("Ada");

          // The picker sidecar cell surfaces the fetch error: the sidecar cache
          // swallows the fetch rejection and resolves to undefined, so the new
          // undefined-pattern branch commits an error UI into the picker cell.
          // Give the deferred fetch a moment to route through and commit.
          const pickerCell = result.key("profile").key(UI).key("props")
            .key("$cell").resolveAsCell();
          const deadline = Date.now() + 5_000;
          let errorNode: any;
          while (Date.now() < deadline) {
            await runtime.idle();
            errorNode = pickerCell.key(UI).get() as any;
            if (errorNode) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(errorNode).toBeDefined();
        } finally {
          globalThis.fetch = originalFetch;
          setPatternEnvironment(originalEnvironment);
          await runtime.idle();
        }
      });

      // CT-1842: In real deployments each profile lives in its OWN space and the
      // `mru` / `defaultProfile` links resolve with a DIFFERENT `scope` than the
      // `profiles` candidates for the same profile (the picker surface stamps its
      // own scope; the home `profiles` list carries another). `Cell.equals`
      // (`areNormalizedLinksSame`) compares `scope`, so the MRU/default match
      // returned false for every candidate and the ordering silently collapsed to
      // `profiles`-list (creation) order — the switcher was a no-op cross-space.
      // The builtin now matches by durable link identity (id + space + path), so
      // the scope skew no longer defeats the match.
      describe("cross-space scope skew (CT-1842)", () => {
        // Stand up N profiles, each in its OWN space (real cross-space), wire the
        // home `profiles` list, and OPTIONALLY write `mru` / `defaultProfile` as
        // links whose stored `scope` differs from the candidate scope — the exact
        // shape that made `Cell.equals` return false for the same profile.
        async function setupCrossSpace(
          label: string,
          opts: {
            names: string[];
            // Indices into `names`, most-recently-used first. Written with a
            // `scope` that differs from the profiles-list candidate scope.
            mruIndices?: number[];
            // Index into `names` to set as default, with a differing scope.
            defaultIndex?: number;
            skewScope?: "user" | "session";
          },
        ) {
          const scope = opts.skewScope ?? "user";
          // Each profile in a DISTINCT space; commit per space (a single tx can
          // only open one space writer at a time).
          const profileCells: Array<ReturnType<Runtime["getCell"]>> = [];
          const links: Array<
            ReturnType<
              ReturnType<Runtime["getCell"]>["getAsNormalizedFullLink"]
            >
          > = [];
          for (let i = 0; i < opts.names.length; i++) {
            const spaceDid = (await Identity.fromPassphrase(
              `ct1842-${label}-space-${i}`,
            )).did();
            const cell = runtime.getCell(
              spaceDid,
              `ct1842-${label}-profile-${i}`,
              undefined,
              tx,
            );
            cell.set({
              name: opts.names[i],
              initialNameApplied: opts.names[i],
              avatar: "",
              bio: "",
              elements: [],
            });
            await tx.commit();
            await runtime.idle();
            tx = runtime.edit();
            profileCells.push(cell);
            links.push(cell.getAsNormalizedFullLink());
          }

          // A scope-skewed sigil link to the same profile entity — the shape a
          // cross-space `mru` / `defaultProfile` entry resolves to in production.
          const skewedSigil = (i: number) => ({
            "/": {
              [LINK_V1_TAG]: {
                id: links[i].id,
                space: links[i].space,
                path: [],
                scope,
              },
            },
          });

          const homeSpaceCell = runtime.getHomeSpaceCell(tx);
          const homeDefaultCell = runtime.getCell(
            userIdentity.did(),
            `ct1842-${label}-home-default`,
            undefined,
            tx,
          );
          homeDefaultCell.key("profiles").set(profileCells);
          if (opts.mruIndices) {
            homeDefaultCell.key("mru").setRawUntyped(
              // deno-lint-ignore no-explicit-any
              opts.mruIndices.map((i) => skewedSigil(i)) as any,
            );
          }
          if (opts.defaultIndex !== undefined) {
            homeDefaultCell.key("defaultProfile").setRawUntyped(
              // deno-lint-ignore no-explicit-any
              skewedSigil(opts.defaultIndex) as any,
            );
          }
          // deno-lint-ignore no-explicit-any
          (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

          await tx.commit();
          await runtime.idle();
          tx = runtime.edit();

          const wishPattern = pattern(() => ({
            profile: wish({ query: "#profile", headless: true }),
          }));
          const resultCell = runtime.getCell<Record<string, any>>(
            patternSpace.did(),
            `ct1842-${label}-result`,
            undefined,
            tx,
          );
          const result = runtime.run(tx, wishPattern, {}, resultCell);
          await tx.commit();
          tx = runtime.edit();
          await result.pull();
          return { result };
        }

        it("MRU head resolves cross-space despite scope-skewed mru links (fails on unfixed code)", async () => {
          // Two profiles in two spaces, no default. MRU lists the SECOND-created
          // profile first, written with a scope that differs from the candidate
          // scope. Pre-fix, `Cell.equals` rejects every mru↔candidate match, so
          // ordering falls back to creation order and `.result` = first-created
          // (Ada). With the identity-based match, `.result` = MRU head (Grace).
          const { result } = await setupCrossSpace("mru-scope-skew", {
            names: ["Ada", "Grace"],
            mruIndices: [1],
          });
          expect(result.key("profile").get()?.result?.name).toBe("Grace");
        });

        it("default resolves cross-space despite scope-skewed default link (guards the default-match fix)", async () => {
          // defaultProfile points at the SECOND profile via a scope-skewed link.
          // Pre-fix the default-match (`defaultCell.equals(candidate)`) fails the
          // same way, so the default is ignored; with the fix it resolves to the
          // chosen default.
          const { result } = await setupCrossSpace("default-scope-skew", {
            names: ["Ada", "Grace"],
            defaultIndex: 1,
          });
          expect(result.key("profile").get()?.result?.name).toBe("Grace");
        });

        it("default outranks MRU even under scope skew", async () => {
          // Default = Ada (index 0), MRU head = Grace (index 1), both skewed.
          // Default must win.
          const { result } = await setupCrossSpace("default-over-mru-skew", {
            names: ["Ada", "Grace"],
            defaultIndex: 0,
            mruIndices: [1],
          });
          expect(result.key("profile").get()?.result?.name).toBe("Ada");
        });
      });
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

  it("includes underscores in the hashtag", () => {
    expect(tagMatchesHashtag("#todo_list", "todo_list")).toBe(true);
    expect(tagMatchesHashtag("#todo_list", "todo")).toBe(false);
  });

  it("ends the hashtag at a hyphen", () => {
    expect(tagMatchesHashtag("#todo-list", "todo")).toBe(true);
    expect(tagMatchesHashtag("#todo-list", "todo-list")).toBe(false);
  });

  it("matches hashtags written in non-Latin scripts", () => {
    expect(tagMatchesHashtag("一篇 #日本語 笔记", "日本語")).toBe(true);
    expect(tagMatchesHashtag("café au #café", "café")).toBe(true);
  });
});

describe("createSidecarPatternCache", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnvironment: ReturnType<typeof getPatternEnvironment>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnvironment = getPatternEnvironment();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setPatternEnvironment(originalEnvironment);
  });

  // Fake runtime whose harness.resolve hands back the resolver's main() source
  // and whose compilePattern echoes that source, so the compiled result names
  // the URL it came from.
  const makeFakeRuntime = () =>
    ({
      harness: {
        resolve: (resolver: { main(): Promise<{ contents: string }> }) =>
          resolver.main(),
      },
      patternManager: {
        compilePattern: (program: { contents: string }) =>
          Promise.resolve({ source: program.contents }),
      },
      userIdentityDID: "did:key:sidecar-cache-test",
    }) as unknown as Runtime;

  // fetch mock that 200s with a body naming the host. Hosts in `failFirst` 404
  // on their first request and succeed afterward. The `gate` host's requests
  // stay pending until the returned `release` is called.
  const installFetchMock = (
    options: { gate?: string; failFirst?: string[] } = {},
  ) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failFirst = new Set(options.failFirst ?? []);
    const calls: string[] = [];
    globalThis.fetch = (async (input: Request | URL | string) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(url.host);
      if (url.host === options.gate) await gate;
      // delete returns true once per host, so only the first request 404s.
      return failFirst.delete(url.host)
        ? new Response("not found", { status: 404 })
        : new Response(`source from ${url.host}`, { status: 200 });
    }) as typeof fetch;
    return { release, calls };
  };

  it("resolves a superseded fetch to undefined and keeps the newer fetch's pattern", async () => {
    // The fetch for env-a.test stays pending until released, so the fetch for
    // env-b.test supersedes it and settles first.
    const { release } = installFetchMock({ gate: "env-a.test" });
    const fakeRuntime = makeFakeRuntime();
    const cache = createSidecarPatternCache({
      name: "profile-create.tsx",
      retryOnFailure: true,
    });

    setPatternEnvironment({ apiUrl: new URL("https://env-a.test/") });
    const firstFetch = cache.fetch(fakeRuntime);

    setPatternEnvironment({ apiUrl: new URL("https://env-b.test/") });
    const secondFetch = cache.fetch(fakeRuntime);

    expect(await secondFetch).toEqual({ source: "source from env-b.test" });
    expect(cache.cached()).toEqual({ source: "source from env-b.test" });

    release();
    expect(await firstFetch).toBeUndefined();
    expect(cache.cached()).toEqual({ source: "source from env-b.test" });
  });

  it("retries after a failed fetch when retryOnFailure is set", async () => {
    // First fetch 404s, the rest succeed.
    const { calls } = installFetchMock({ failFirst: ["env-a.test"] });
    const fakeRuntime = makeFakeRuntime();
    setPatternEnvironment({ apiUrl: new URL("https://env-a.test/") });
    const cache = createSidecarPatternCache({
      name: "profile-create.tsx",
      retryOnFailure: true,
    });

    expect(await cache.fetch(fakeRuntime)).toBeUndefined();
    expect(cache.cached()).toBeUndefined();
    // The cleared memoization lets a later launch re-fetch the same URL.
    expect(await cache.fetch(fakeRuntime)).toEqual({
      source: "source from env-a.test",
    });
    expect(calls).toEqual(["env-a.test", "env-a.test"]);
  });

  it("keeps a failed fetch without retrying when retryOnFailure is not set", async () => {
    const { calls } = installFetchMock({ failFirst: ["env-a.test"] });
    const fakeRuntime = makeFakeRuntime();
    setPatternEnvironment({ apiUrl: new URL("https://env-a.test/") });
    // suggestion.tsx's policy: a failed fetch is kept, not retried.
    const cache = createSidecarPatternCache({ name: "suggestion.tsx" });

    expect(await cache.fetch(fakeRuntime)).toBeUndefined();
    expect(await cache.fetch(fakeRuntime)).toBeUndefined();
    expect(cache.cached()).toBeUndefined();
    expect(calls).toEqual(["env-a.test"]);
  });

  it("invokes onSuccess only for the fetch that records its pattern", async () => {
    const { release } = installFetchMock({ gate: "env-a.test" });
    const fakeRuntime = makeFakeRuntime();
    const cache = createSidecarPatternCache({
      name: "profile-create.tsx",
      retryOnFailure: true,
    });

    const recorded: unknown[] = [];
    const record = (pattern: unknown) => recorded.push(pattern);

    setPatternEnvironment({ apiUrl: new URL("https://env-a.test/") });
    const firstFetch = cache.fetch(fakeRuntime, record);

    setPatternEnvironment({ apiUrl: new URL("https://env-b.test/") });
    const secondFetch = cache.fetch(fakeRuntime, record);

    expect(await secondFetch).toEqual({ source: "source from env-b.test" });

    release();
    await firstFetch;

    // The winning env-b fetch reports through onSuccess; the superseded env-a
    // fetch does not.
    expect(recorded).toEqual([{ source: "source from env-b.test" }]);
  });
});
