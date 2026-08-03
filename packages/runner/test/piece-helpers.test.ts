import { assertEquals, assertThrows } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  getResultCellWithSourceSchema,
  isLegacyPieceRegistryRoot,
  parseCellPath,
  resolveCellPath,
} from "../src/piece-helpers.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test piece helpers");
const space = signer.did();

interface FakeCell {
  readonly schema?: undefined;
  get(): unknown;
  key(segment: string | number): FakeCell;
  resolveAsCell(): FakeCell;
}

function makeCell(
  value: unknown,
  children: Record<string, FakeCell> = {},
): FakeCell {
  return {
    get() {
      return value;
    },
    key(segment: string | number) {
      return children[String(segment)] ?? makeCell(undefined);
    },
    resolveAsCell() {
      return this;
    },
  };
}

describe("parseCellPath", () => {
  it("parses slash paths and numeric array indexes", () => {
    assertEquals(parseCellPath("users/0/name"), ["users", 0, "name"]);
    assertEquals(parseCellPath("value/3.14/pi"), ["value", "3.14", "pi"]);
    assertEquals(parseCellPath("values/-1/negative"), [
      "values",
      "-1",
      "negative",
    ]);
    assertEquals(parseCellPath(""), []);
  });
});

describe("resolveCellPath", () => {
  it("resolves schema-backed child cells when the parent object is sparse", () => {
    const cell = makeCell(undefined, {
      messageCount: makeCell(1),
    });

    assertEquals(resolveCellPath(cell as never, ["messageCount"]), 1);
  });

  it("throws when the requested path is missing", () => {
    const cell = makeCell(undefined);

    assertThrows(
      () => resolveCellPath(cell as never, ["missing"]),
      Error,
      'property "missing" not found',
    );
  });

  it("throws when traversing through a non-object value", () => {
    const cell = makeCell({
      settings: "plain-text",
    }, {
      settings: makeCell("plain-text"),
    });

    assertThrows(
      () => resolveCellPath(cell as never, ["settings", "theme"]),
      Error,
      'encountered non-object at "theme"',
    );
  });
});

describe("resolveCellPath through linked slots", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  it("reads through a cell link at an intermediate segment", () => {
    // The deploy shape that hit this: a piece whose `status` field is a
    // LINK to another cell (`cf piece link`), read back as
    // `status/spaceName`. The leaf already derefs a cell-valued result;
    // an intermediate segment must do the same or the traversal inspects
    // the Cell instance's own JS properties and reports its internals as
    // "available keys".
    const statusCell = runtime.getCell(
      space,
      "linked status source",
      undefined,
      tx,
    );
    statusCell.set({ spaceName: "test-space" });

    const pieceCell = runtime.getCell(
      space,
      "piece with linked status",
      undefined,
      tx,
    );
    pieceCell.set({ status: statusCell });

    assertEquals(
      resolveCellPath(pieceCell as never, ["status", "spaceName"]),
      "test-space",
    );
  });

  it("reads through an asCell-schema slot at an intermediate segment", () => {
    // A piece result whose schema declares the linked field asCell (the
    // Writable<...> output shape) surfaces the slot as a Cell from get():
    // the parent's value then holds a live Cell instance, and traversal
    // must read through it rather than inspecting the Cell's own JS
    // properties (which reports runner internals as "available keys").
    const statusCell = runtime.getCell(
      space,
      "asCell status source",
      undefined,
      tx,
    );
    statusCell.set({ spaceName: "test-space" });

    const pieceCell = runtime.getCell(
      space,
      "piece with asCell status",
      {
        type: "object",
        properties: {
          status: {
            type: "object",
            properties: { spaceName: { type: "string" } },
            asCell: ["cell"],
          },
        },
      } as const,
      tx,
    );
    pieceCell.set({ status: statusCell as never });

    assertEquals(
      resolveCellPath(pieceCell as never, ["status", "spaceName"]),
      "test-space",
    );
  });

  it("reads through a nested asCell slot at an intermediate segment", () => {
    const statusCell = runtime.getCell(
      space,
      "nested asCell status source",
      { type: "object", properties: { spaceName: { type: "string" } } },
      tx,
    );
    statusCell.set({ spaceName: "test-space" });
    const innerHandle = runtime.getCell(
      space,
      "nested asCell status handle",
      {
        type: "object",
        properties: { spaceName: { type: "string" } },
        asCell: ["cell"],
      },
      tx,
    );
    innerHandle.set(statusCell as never);

    const pieceCell = runtime.getCell(
      space,
      "piece with nested asCell status",
      {
        type: "object",
        properties: {
          status: {
            type: "object",
            properties: { spaceName: { type: "string" } },
            asCell: ["cell", "cell"],
          },
        },
      },
      tx,
    );
    pieceCell.set({ status: innerHandle as never });

    assertEquals(
      resolveCellPath(pieceCell as never, ["status", "spaceName"]),
      "test-space",
    );
  });

  it("still reports non-object traversal through a cell-valued slot", () => {
    // Reading through the cell must not weaken the non-object guard: a
    // linked slot holding a scalar still errors when the path continues.
    const scalarCell = runtime.getCell(
      space,
      "linked scalar source",
      undefined,
      tx,
    );
    scalarCell.set("plain-text");

    const pieceCell = runtime.getCell(
      space,
      "piece with linked scalar",
      undefined,
      tx,
    );
    pieceCell.set({ settings: scalarCell });

    assertThrows(
      () => resolveCellPath(pieceCell as never, ["settings", "theme"]),
      Error,
      'encountered non-object at "theme"',
    );
  });
});

describe("getResultCellWithSourceSchema", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  it("uses result schema metadata to annotate child result cells", () => {
    const resultSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        detail: {
          type: "object",
          properties: {
            count: { type: "number" },
          },
          required: ["count"],
        },
      },
      required: ["title", "detail"],
    } as const;
    const resultCell = runtime.getCell(
      space,
      "piece helper result schema metadata",
      undefined,
      tx,
    );
    resultCell.setMetaRaw("schema", resultSchema);

    const titleCell = getResultCellWithSourceSchema(
      resultCell.key("title"),
    );
    const countCell = getResultCellWithSourceSchema(
      resultCell.key("detail").key("count"),
    );

    assertEquals(titleCell.getAsNormalizedFullLink().schema, {
      type: "string",
    });
    assertEquals(countCell.getAsNormalizedFullLink().schema, {
      type: "number",
    });
  });

  it("keeps an explicit link schema instead of replacing it from metadata", () => {
    const resultSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
    } as const;
    const explicitSchema = { type: "number" } as const;
    const resultCell = runtime.getCell(
      space,
      "piece helper explicit schema",
      undefined,
      tx,
    );
    resultCell.setMetaRaw("schema", resultSchema);

    const explicitCell = resultCell.key("title").asSchema(explicitSchema);
    const annotated = getResultCellWithSourceSchema(explicitCell);

    assertEquals(annotated.getAsNormalizedFullLink().schema, explicitSchema);
  });
});

describe("isLegacyPieceRegistryRoot", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  const HOST = "http://toolshed.test";

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(HOST), storageManager });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  // A root in the shape the predicate looks for: the retired `allPieces` field
  // with its `addPiece` stream, and no `pieceRegistry`.
  async function legacyShapedRoot(patternSource?: unknown) {
    const root = runtime.getCell<Record<string, unknown>>(
      space,
      `legacy-registry-root-${crypto.randomUUID()}`,
    );
    const { error } = await runtime.editWithRetry((tx) => {
      const withTx = root.withTx(tx);
      withTx.set({
        allPieces: [],
        addPiece: { $stream: true },
      } as unknown as Record<string, unknown>);
      withTx.setMetaRaw("patternIdentity", {
        identity: "fid1:whatever",
        symbol: "default",
      });
      if (patternSource !== undefined) {
        withTx.setMetaRaw("patternSource", patternSource as never);
      }
    });
    assertEquals(error, undefined);
    return root;
  }

  it("accepts every spelling of the official default-app source", async () => {
    // The three that name the same file: the ref a root is stamped with today,
    // the rooted route path, and the absolute href a recorded source
    // transition rewrites that path into against the space's own host.
    for (
      const source of [
        undefined,
        "system:system/default-app.tsx",
        "/api/patterns/system/default-app.tsx",
        `${HOST}/api/patterns/system/default-app.tsx`,
      ]
    ) {
      assertEquals(
        isLegacyPieceRegistryRoot(await legacyShapedRoot(source)),
        true,
        `expected ${String(source)} to qualify`,
      );
    }
  });

  it("refuses a root tracking anything else", async () => {
    // Another host's copy is a different source, not another spelling — and a
    // custom pattern is exactly what the predicate exists to exclude.
    for (
      const source of [
        "system:custom/my-app.tsx",
        "/api/patterns/custom/my-app.tsx",
        "http://elsewhere.test/api/patterns/system/default-app.tsx",
        "cf:published-pattern",
        42,
      ]
    ) {
      assertEquals(
        isLegacyPieceRegistryRoot(await legacyShapedRoot(source)),
        false,
        `expected ${String(source)} to be refused`,
      );
    }
  });
});
