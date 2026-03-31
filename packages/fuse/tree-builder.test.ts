// tree-builder.test.ts — Unit tests for JSON-to-tree conversion and symlink parsing
import { assertEquals } from "@std/assert";
import { FsTree } from "./tree.ts";
import {
  buildCallableScript,
  classifyCallableEntry,
  isPatternToolValue,
} from "./callables.ts";
import {
  buildJsonTree,
  isHandlerCell,
  isSigilLink,
  isStreamValue,
  safeStringify,
  transformStreamValues,
} from "./tree-builder.ts";
import { CellBridge } from "./cell-bridge.ts";

const decoder = new TextDecoder();

function getFileContent(tree: FsTree, parentIno: bigint, name: string): string {
  const ino = tree.lookup(parentIno, name);
  if (ino === undefined) throw new Error(`File ${name} not found`);
  const node = tree.getNode(ino);
  if (!node || node.kind !== "file") throw new Error(`${name} is not a file`);
  return decoder.decode(node.content);
}

Deno.test("buildJsonTree - null value creates empty file", () => {
  const tree = new FsTree();
  buildJsonTree(tree, tree.rootIno, "empty", null);

  const ino = tree.lookup(tree.rootIno, "empty");
  assertEquals(ino !== undefined, true);
  const node = tree.getNode(ino!);
  assertEquals(node?.kind, "file");
  if (node?.kind === "file") {
    assertEquals(node.jsonType, "null");
    assertEquals(node.content.length, 0);
  }
});

Deno.test("buildJsonTree - boolean values", () => {
  const tree = new FsTree();
  buildJsonTree(tree, tree.rootIno, "flag", true);
  assertEquals(getFileContent(tree, tree.rootIno, "flag"), "true");

  buildJsonTree(tree, tree.rootIno, "off", false);
  assertEquals(getFileContent(tree, tree.rootIno, "off"), "false");
});

Deno.test("buildJsonTree - number values", () => {
  const tree = new FsTree();
  buildJsonTree(tree, tree.rootIno, "count", 42);
  assertEquals(getFileContent(tree, tree.rootIno, "count"), "42");

  buildJsonTree(tree, tree.rootIno, "pi", 3.14);
  assertEquals(getFileContent(tree, tree.rootIno, "pi"), "3.14");
});

Deno.test("buildJsonTree - string values", () => {
  const tree = new FsTree();
  buildJsonTree(tree, tree.rootIno, "greeting", "hello world");
  assertEquals(getFileContent(tree, tree.rootIno, "greeting"), "hello world");
});

Deno.test("buildJsonTree - object creates directory with children", () => {
  const tree = new FsTree();
  const obj = { name: "Alice", age: 30, active: true };
  buildJsonTree(tree, tree.rootIno, "user", obj);

  // Should create a directory
  const dirIno = tree.lookup(tree.rootIno, "user");
  assertEquals(dirIno !== undefined, true);
  const dirNode = tree.getNode(dirIno!);
  assertEquals(dirNode?.kind, "dir");

  // Should have children
  assertEquals(getFileContent(tree, dirIno!, "name"), "Alice");
  assertEquals(getFileContent(tree, dirIno!, "age"), "30");
  assertEquals(getFileContent(tree, dirIno!, "active"), "true");

  // Should have .json sibling
  const jsonContent = getFileContent(tree, tree.rootIno, "user.json");
  assertEquals(JSON.parse(jsonContent), obj);
});

Deno.test("buildJsonTree - array creates directory with numeric indices", () => {
  const tree = new FsTree();
  const arr = ["a", "b", "c"];
  buildJsonTree(tree, tree.rootIno, "items", arr);

  const dirIno = tree.lookup(tree.rootIno, "items");
  assertEquals(dirIno !== undefined, true);
  const dirNode = tree.getNode(dirIno!);
  assertEquals(dirNode?.kind, "dir");

  assertEquals(getFileContent(tree, dirIno!, "0"), "a");
  assertEquals(getFileContent(tree, dirIno!, "1"), "b");
  assertEquals(getFileContent(tree, dirIno!, "2"), "c");

  // Should have .json sibling
  const jsonContent = getFileContent(tree, tree.rootIno, "items.json");
  assertEquals(JSON.parse(jsonContent), arr);
});

Deno.test("buildJsonTree - nested objects", () => {
  const tree = new FsTree();
  const data = {
    user: {
      name: "Bob",
      address: {
        city: "NYC",
        zip: 10001,
      },
    },
  };
  buildJsonTree(tree, tree.rootIno, "data", data);

  const dataIno = tree.lookup(tree.rootIno, "data")!;
  const userIno = tree.lookup(dataIno, "user")!;
  const addressIno = tree.lookup(userIno, "address")!;

  assertEquals(getFileContent(tree, userIno, "name"), "Bob");
  assertEquals(getFileContent(tree, addressIno, "city"), "NYC");
  assertEquals(getFileContent(tree, addressIno, "zip"), "10001");
});

Deno.test("FsTree - clear removes subtree", () => {
  const tree = new FsTree();
  const data = { a: { b: 1, c: 2 }, d: 3 };
  buildJsonTree(tree, tree.rootIno, "root", data);

  const rootDirIno = tree.lookup(tree.rootIno, "root")!;
  const aIno = tree.lookup(rootDirIno, "a")!;

  // Clear the 'a' subtree
  tree.clear(aIno);

  // 'a' should be gone
  assertEquals(tree.lookup(rootDirIno, "a"), undefined);
  assertEquals(tree.getNode(aIno), undefined);

  // 'd' should still exist
  assertEquals(getFileContent(tree, rootDirIno, "d"), "3");
});

Deno.test("buildJsonTree - circular references become [Circular]", () => {
  const tree = new FsTree();
  // deno-lint-ignore no-explicit-any
  const obj: any = { name: "loop" };
  obj.self = obj; // circular

  buildJsonTree(tree, tree.rootIno, "circ", obj);

  const dirIno = tree.lookup(tree.rootIno, "circ")!;
  assertEquals(getFileContent(tree, dirIno, "name"), "loop");
  assertEquals(getFileContent(tree, dirIno, "self"), "[Circular]");

  // .json sibling should also handle circularity
  const json = getFileContent(tree, tree.rootIno, "circ.json");
  const parsed = JSON.parse(json);
  assertEquals(parsed.name, "loop");
  assertEquals(parsed.self, "[Circular]");
});

Deno.test("safeStringify - handles circular refs", () => {
  // deno-lint-ignore no-explicit-any
  const a: any = { x: 1 };
  a.y = a;
  const result = JSON.parse(safeStringify(a));
  assertEquals(result.x, 1);
  assertEquals(result.y, "[Circular]");
});

Deno.test("FsTree - addSymlink", () => {
  const tree = new FsTree();
  tree.addSymlink(tree.rootIno, "link", "../target/path");

  const ino = tree.lookup(tree.rootIno, "link");
  assertEquals(ino !== undefined, true);
  const node = tree.getNode(ino!);
  assertEquals(node?.kind, "symlink");
  if (node?.kind === "symlink") {
    assertEquals(node.target, "../target/path");
  }
});

// --- Sigil link tests ---

Deno.test("isSigilLink - detects valid sigil links", () => {
  assertEquals(
    isSigilLink({ "/": { "link@1": { id: "bafy123" } } }),
    true,
  );
  assertEquals(
    isSigilLink({ "/": { "link@1": { id: "bafy123", path: ["name"] } } }),
    true,
  );
  assertEquals(
    isSigilLink({
      "/": { "link@1": { id: "bafy123", space: "other" } },
    }),
    true,
  );
  assertEquals(
    isSigilLink({ "/": { "link@1": {} } }),
    true,
  );
});

Deno.test("isSigilLink - rejects non-sigil values", () => {
  assertEquals(isSigilLink(null), false);
  assertEquals(isSigilLink(42), false);
  assertEquals(isSigilLink("hello"), false);
  assertEquals(isSigilLink([1, 2]), false);
  assertEquals(isSigilLink({ name: "Alice" }), false);
  assertEquals(isSigilLink({ "/": "not-an-object" }), false);
  assertEquals(isSigilLink({ "/": { other: 1 } }), false);
  // Extra keys disqualify
  assertEquals(isSigilLink({ "/": { "link@1": {} }, extra: true }), false);
});

Deno.test("isHandlerCell - detects stream cells via duck-typing", () => {
  // Mock Cell with isStream() returning true
  assertEquals(isHandlerCell({ isStream: () => true }), true);
  // Mock Cell with isStream() returning false
  assertEquals(isHandlerCell({ isStream: () => false }), false);
  // Not a Cell — no isStream method
  assertEquals(isHandlerCell({ name: "Alice" }), false);
  assertEquals(isHandlerCell(42), false);
  assertEquals(isHandlerCell(null), false);
  assertEquals(isHandlerCell({ $stream: true }), false);
});

Deno.test("buildJsonTree - handler cells skipped via skipEntry", () => {
  const tree = new FsTree();

  // Simulate live Cell objects with isStream() (as returned by piece.result.get())
  const data = {
    value: 10,
    increment: {
      isStream: () => true,
      toJSON() {
        return { "/handler": "increment" };
      },
    },
    decrement: {
      isStream: () => true,
      toJSON() {
        return { "/handler": "decrement" };
      },
    },
  };

  const resolveLink = (_value: unknown, depth: number): string | null => {
    return "../".repeat(depth + 2) + "entities/test";
  };
  const skipEntry = (val: unknown) => isHandlerCell(val);

  const resultIno = buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    data,
    undefined,
    resolveLink,
    0,
    skipEntry,
  );

  // "value" should exist as a file
  const valueIno = tree.lookup(resultIno, "value");
  assertEquals(valueIno !== undefined, true);

  // "increment" and "decrement" should be skipped (not in tree)
  assertEquals(tree.lookup(resultIno, "increment"), undefined);
  assertEquals(tree.lookup(resultIno, "decrement"), undefined);

  // The .json sibling should have handler sigils
  const jsonIno = tree.lookup(tree.rootIno, "result.json");
  assertEquals(jsonIno !== undefined, true);
  const jsonContent = getFileContent(tree, tree.rootIno, "result.json");
  const parsed = JSON.parse(jsonContent);
  assertEquals(parsed.increment, { "/handler": "increment" });
  assertEquals(parsed.decrement, { "/handler": "decrement" });
  assertEquals(parsed.value, 10);
});

Deno.test("buildJsonTree - sigil link becomes symlink via resolveLink", () => {
  const tree = new FsTree();

  const resolveLink = (_value: unknown, depth: number): string | null => {
    return "../".repeat(depth + 2) + "entities/bafy123";
  };

  const data = {
    ref: { "/": { "link@1": { id: "bafy123" } } },
    name: "Alice",
  };

  buildJsonTree(tree, tree.rootIno, "result", data, undefined, resolveLink, 0);

  const resultIno = tree.lookup(tree.rootIno, "result")!;

  // "ref" should be a symlink
  const refIno = tree.lookup(resultIno, "ref")!;
  const refNode = tree.getNode(refIno);
  assertEquals(refNode?.kind, "symlink");
  if (refNode?.kind === "symlink") {
    // depth=1 (inside "result"), so depth+2=3 ups
    assertEquals(refNode.target, "../../../entities/bafy123");
  }

  // "name" should still be a normal file
  assertEquals(getFileContent(tree, resultIno, "name"), "Alice");
});

Deno.test("buildJsonTree - sigil link in nested array gets correct depth", () => {
  const tree = new FsTree();

  const resolveLink = (_value: unknown, depth: number): string | null => {
    return "../".repeat(depth + 2) + "entities/xyz";
  };

  const data = {
    items: [
      { "/": { "link@1": { id: "xyz" } } },
    ],
  };

  buildJsonTree(tree, tree.rootIno, "result", data, undefined, resolveLink, 0);

  const resultIno = tree.lookup(tree.rootIno, "result")!;
  const itemsIno = tree.lookup(resultIno, "items")!;
  const linkIno = tree.lookup(itemsIno, "0")!;
  const linkNode = tree.getNode(linkIno);

  assertEquals(linkNode?.kind, "symlink");
  if (linkNode?.kind === "symlink") {
    // depth=2 (result/items/0), so depth+2=4 ups
    assertEquals(linkNode.target, "../../../../entities/xyz");
  }
});

Deno.test("buildJsonTree - unresolvable sigil link falls through to object", () => {
  const tree = new FsTree();

  const resolveLink = (): string | null => null;

  const data = {
    ref: { "/": { "link@1": { id: "bafy123" } } },
  };

  buildJsonTree(tree, tree.rootIno, "result", data, undefined, resolveLink, 0);

  const resultIno = tree.lookup(tree.rootIno, "result")!;
  const refIno = tree.lookup(resultIno, "ref")!;
  const refNode = tree.getNode(refIno);
  // Falls through to directory since it's an object
  assertEquals(refNode?.kind, "dir");
});

// --- Stream / handler tests ---

Deno.test("isStreamValue - detects stream markers", () => {
  assertEquals(isStreamValue({ $stream: true }), true);
  assertEquals(isStreamValue({ $stream: true, extra: 1 }), true);
});

Deno.test("isStreamValue - rejects non-stream values", () => {
  assertEquals(isStreamValue(null), false);
  assertEquals(isStreamValue(42), false);
  assertEquals(isStreamValue("hello"), false);
  assertEquals(isStreamValue([1, 2]), false);
  assertEquals(isStreamValue({ name: "Alice" }), false);
  assertEquals(isStreamValue({ $stream: false }), false);
  assertEquals(isStreamValue({}), false);
});

Deno.test("transformStreamValues - replaces stream markers with handler sigils", () => {
  const input = {
    items: [1, 2, 3],
    count: 3,
    addItem: { $stream: true },
  };
  const result = transformStreamValues(input) as Record<string, unknown>;
  assertEquals(result.items, [1, 2, 3]);
  assertEquals(result.count, 3);
  assertEquals(result.addItem, { "/handler": "addItem" });
});

Deno.test("transformStreamValues - returns original when no streams", () => {
  const input = { name: "Alice", age: 30 };
  const result = transformStreamValues(input);
  // Should be the exact same reference
  assertEquals(result === input, true);
});

Deno.test("transformStreamValues - passes through non-objects", () => {
  assertEquals(transformStreamValues(null), null);
  assertEquals(transformStreamValues(42), 42);
  assertEquals(transformStreamValues("hello"), "hello");
  assertEquals(transformStreamValues([1, 2]), [1, 2]);
});

Deno.test("buildJsonTree - stream values are skipped in object directories", () => {
  const tree = new FsTree();
  const data = {
    items: ["a", "b"],
    count: 2,
    addItem: { $stream: true },
    reset: { $stream: true },
  };
  buildJsonTree(tree, tree.rootIno, "result", data);

  const resultIno = tree.lookup(tree.rootIno, "result")!;
  const resultNode = tree.getNode(resultIno);
  assertEquals(resultNode?.kind, "dir");

  // Regular keys should exist
  const itemsIno = tree.lookup(resultIno, "items");
  assertEquals(itemsIno !== undefined, true);
  assertEquals(getFileContent(tree, resultIno, "count"), "2");

  // Stream keys should NOT exist as files or dirs
  assertEquals(tree.lookup(resultIno, "addItem"), undefined);
  assertEquals(tree.lookup(resultIno, "reset"), undefined);
});

Deno.test("buildJsonTree - .json sibling replaces streams with handler sigils", () => {
  const tree = new FsTree();
  const data = {
    items: ["a"],
    addItem: { $stream: true },
  };
  buildJsonTree(tree, tree.rootIno, "result", data);

  const json = getFileContent(tree, tree.rootIno, "result.json");
  const parsed = JSON.parse(json);
  assertEquals(parsed.items, ["a"]);
  assertEquals(parsed.addItem, { "/handler": "addItem" });
});

Deno.test("classifyCallableEntry does not treat ordinary data as a tool when linked schema disagrees", () => {
  const value = {
    pattern: "just-data",
    extraParams: {
      source: "still-data",
    },
  };
  const schema = {
    type: "object",
    properties: {
      pattern: { type: "string" },
      extraParams: {
        type: "object",
        properties: {
          source: { type: "string" },
        },
      },
    },
  } as const;

  assertEquals(classifyCallableEntry(value, schema), null);
});

Deno.test("buildJsonTree - nested .json siblings keep ordinary pattern-shaped objects intact", () => {
  const tree = new FsTree();
  const data = {
    nested: {
      config: {
        pattern: "literal-pattern",
        extraParams: {
          mode: "keep",
        },
      },
    },
  };

  buildJsonTree(tree, tree.rootIno, "result", data);

  const resultIno = tree.lookup(tree.rootIno, "result");
  if (resultIno === undefined) throw new Error("result dir not found");

  const nestedJson = JSON.parse(getFileContent(tree, resultIno, "nested.json"));
  assertEquals(nestedJson, {
    config: {
      pattern: "literal-pattern",
      extraParams: {
        mode: "keep",
      },
    },
  });
});

Deno.test("buildJsonTree - root .json siblings keep ordinary pattern-shaped objects intact without a classifier", () => {
  const tree = new FsTree();
  const data = {
    pattern: "literal-pattern",
    extraParams: {
      mode: "keep",
    },
  };

  buildJsonTree(tree, tree.rootIno, "result", data);

  const parsed = JSON.parse(getFileContent(tree, tree.rootIno, "result.json"));
  assertEquals(parsed, data);
});

Deno.test("FsTree - addCallable creates callable handler node", () => {
  const tree = new FsTree();
  const dirIno = tree.addDir(tree.rootIno, "result", "object");
  const handlerIno = tree.addCallable(
    dirIno,
    "addItem.handler",
    "handler",
    "addItem",
    "result",
    buildCallableScript("/tmp/ct-exec"),
  );

  const node = tree.getNode(handlerIno);
  assertEquals(node?.kind, "callable");
  if (node?.kind === "callable") {
    assertEquals(node.callableKind, "handler");
    assertEquals(node.cellKey, "addItem");
    assertEquals(node.cellProp, "result");
  }

  // Should be findable via lookup
  assertEquals(tree.lookup(dirIno, "addItem.handler"), handlerIno);
});

Deno.test("FsTree - handler nodes coexist with regular files", () => {
  const tree = new FsTree();
  const dirIno = tree.addDir(tree.rootIno, "result", "object");
  tree.addFile(dirIno, "count", "3", "number");
  tree.addCallable(
    dirIno,
    "addItem.handler",
    "handler",
    "addItem",
    "result",
    buildCallableScript("/tmp/ct-exec"),
  );
  tree.addCallable(
    dirIno,
    "reset.handler",
    "handler",
    "reset",
    "result",
    buildCallableScript("/tmp/ct-exec"),
  );

  const children = tree.getChildren(dirIno);
  const names = children.map(([name]) => name).sort();
  assertEquals(names, ["addItem.handler", "count", "reset.handler"]);
});

Deno.test("FsTree - clear removes handler nodes", () => {
  const tree = new FsTree();
  const dirIno = tree.addDir(tree.rootIno, "result", "object");
  const handlerIno = tree.addCallable(
    dirIno,
    "add.handler",
    "handler",
    "add",
    "result",
    buildCallableScript("/tmp/ct-exec"),
  );

  tree.clear(dirIno);

  assertEquals(tree.getNode(handlerIno), undefined);
  assertEquals(tree.lookup(tree.rootIno, "result"), undefined);
});

Deno.test("buildJsonTree - .tool callables appear beside ordinary fields", () => {
  const tree = new FsTree();
  const data = {
    count: 3,
    search: {
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      extraParams: { source: "items" },
    },
  };

  const resultIno = buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    data,
    undefined,
    undefined,
    0,
    (value) => isPatternToolValue(value),
  );
  const script = buildCallableScript("/tmp/ct-exec");
  const callableIno = tree.addCallable(
    resultIno,
    "search.tool",
    "tool",
    "search",
    "result",
    script,
  );

  assertEquals(getFileContent(tree, resultIno, "count"), "3");
  assertEquals(tree.lookup(resultIno, "search"), undefined);
  assertEquals(tree.lookup(resultIno, "search.tool"), callableIno);

  const callableNode = tree.getNode(callableIno);
  assertEquals(callableNode?.kind, "callable");
  if (callableNode?.kind === "callable") {
    assertEquals(callableNode.callableKind, "tool");
    assertEquals(callableNode.cellKey, "search");
    assertEquals(callableNode.cellProp, "result");
  }
});

Deno.test("buildJsonTree - .json siblings replace handlers and tools with sigils", () => {
  const tree = new FsTree();
  const data = {
    count: 3,
    addItem: { $stream: true },
    search: {
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      extraParams: { source: "items" },
    },
  };

  buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    data,
    undefined,
    undefined,
    0,
    (value) => isHandlerCell(value) || isPatternToolValue(value),
    (_key, value) => {
      if (isHandlerCell(value) || isStreamValue(value)) return "handler";
      return isPatternToolValue(value) ? "tool" : null;
    },
  );

  const parsed = JSON.parse(getFileContent(tree, tree.rootIno, "result.json"));
  assertEquals(parsed.count, 3);
  assertEquals(parsed.addItem, { "/handler": "addItem" });
  assertEquals(parsed.search, { "/tool": "search" });
});

Deno.test("callable scripts begin with a ct exec shebang and shell fallback", () => {
  const tree = new FsTree();
  const resultIno = tree.addDir(tree.rootIno, "result", "object");
  const callableIno = tree.addCallable(
    resultIno,
    "search.tool",
    "tool",
    "search",
    "result",
    buildCallableScript("/tmp/ct-exec"),
  );

  const node = tree.getNode(callableIno);
  assertEquals(node?.kind, "callable");
  if (node?.kind === "callable") {
    const [firstLine, secondLine] = decoder.decode(node.script).split("\n");
    assertEquals(firstLine.startsWith("#!"), true);
    assertEquals(firstLine.includes(" exec"), true);
    assertEquals(secondLine.includes(' exec "$0" "$@"'), true);
  }
});

Deno.test("CellBridge.sendToHandler resolves mounted callable paths under pieces and entities", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree);
  const calls: Array<{
    channel: "input" | "result";
    path: (string | number)[] | undefined;
    value: unknown;
  }> = [];
  const makeChannel = (channel: "input" | "result") => ({
    key: (key: string) => ({
      send: (value: unknown) => {
        calls.push({ channel, value, path: [key] });
      },
    }),
  });
  const piece = {
    id: "of:entity-123",
    input: {
      getCell: () => Promise.resolve(makeChannel("input")),
    },
    result: {
      getCell: () => Promise.resolve(makeChannel("result")),
    },
    manager: () => ({
      runtime: { idle: () => Promise.resolve() },
      synced: () => Promise.resolve(),
    }),
  };

  const spaceIno = tree.addDir(tree.rootIno, "home");
  const piecesIno = tree.addDir(spaceIno, "pieces");
  const entitiesIno = tree.addDir(spaceIno, "entities");
  const pieceIno = tree.addDir(piecesIno, "notes");
  const pieceResultIno = tree.addDir(pieceIno, "result", "object");
  const entityIno = tree.addDir(entitiesIno, "entity-123");
  const entityResultIno = tree.addDir(entityIno, "result", "object");
  const script = buildCallableScript("/tmp/ct-exec");

  const piecesHandlerIno = tree.addCallable(
    pieceResultIno,
    "add.handler",
    "handler",
    "add",
    "result",
    script,
  );
  const entitiesHandlerIno = tree.addCallable(
    entityResultIno,
    "add.handler",
    "handler",
    "add",
    "result",
    script,
  );

  bridge.spaces.set("home", {
    manager: {} as never,
    pieces: {} as never,
    spaceIno,
    piecesIno,
    entitiesIno,
    pieceMap: new Map([["notes", "of:entity-123"]]),
    pieceControllers: new Map([["notes", piece as never]]),
    pieceSubs: new Map(),
    did: "did:key:home",
    unsubscribes: [],
    usedNames: new Set(["notes"]),
  });

  await bridge.sendToHandler(piecesHandlerIno, { count: 1 });
  await bridge.sendToHandler(entitiesHandlerIno, { count: 2 });

  assertEquals(calls, [
    { channel: "result", value: { count: 1 }, path: ["add"] },
    { channel: "result", value: { count: 2 }, path: ["add"] },
  ]);
});

Deno.test("CellBridge.loadPieceTree materializes callable dirs from sparse result roots", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/ct-exec");

  interface FakeCell {
    schema: Record<string, unknown> | undefined;
    get(): unknown;
    getRaw(): unknown;
    asSchemaFromLinks(): FakeCell;
    key(segment: string): FakeCell;
    isStream?: () => boolean;
  }

  function makeCell(
    value: unknown,
    schema: Record<string, unknown> | undefined,
    children: Record<string, FakeCell> = {},
    options: { isStream?: boolean } = {},
  ): FakeCell {
    return {
      schema,
      get: () => value,
      getRaw: () => value,
      asSchemaFromLinks() {
        return this;
      },
      key(segment: string) {
        return children[segment] ?? makeCell(undefined, undefined);
      },
      isStream: options.isStream ? () => true : undefined,
    };
  }

  const handlerCell = makeCell(undefined, undefined, {}, { isStream: true });
  const toolCell = makeCell(
    {
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      extraParams: { source: "bound-source" },
    },
    undefined,
  );
  const resultCell = makeCell(
    undefined,
    {
      type: "object",
      properties: {
        recordMessage: { type: "object" },
        search: { type: "object" },
      },
    },
    {
      recordMessage: handlerCell,
      search: toolCell,
    },
  );

  const piece = {
    id: "of:entity-123",
    name: () => "Sparse Fixture",
    getPatternMeta: () => Promise.resolve({ patternName: "Sparse Fixture" }),
    input: {
      getCell: () =>
        Promise.resolve(
          makeCell(undefined, { type: "object", properties: {} }),
        ),
      get: () => Promise.resolve(undefined),
    },
    result: {
      getCell: () => Promise.resolve(resultCell),
      get: () => Promise.resolve(undefined),
    },
  };

  interface SparsePiece {
    id: string;
    name(): string;
    getPatternMeta(): Promise<{ patternName: string }>;
    input: {
      getCell(): Promise<FakeCell>;
      get(): Promise<unknown>;
    };
    result: {
      getCell(): Promise<FakeCell>;
      get(): Promise<unknown>;
    };
  }

  type LoadPieceTree = (
    piece: SparsePiece,
    parentIno: bigint,
    name: string,
    spaceName: string,
  ) => Promise<bigint>;

  const pieceIno = await (bridge as unknown as {
    loadPieceTree: LoadPieceTree;
  }).loadPieceTree(piece, tree.rootIno, "Sparse Fixture", "home");

  const resultIno = tree.lookup(pieceIno, "result");
  assertEquals(resultIno !== undefined, true);
  assertEquals(
    tree.lookup(resultIno!, "recordMessage.handler") !== undefined,
    true,
  );
  assertEquals(tree.lookup(resultIno!, "search.tool") !== undefined, true);

  const resultJson = JSON.parse(getFileContent(tree, pieceIno, "result.json"));
  assertEquals(resultJson.recordMessage, { "/handler": "recordMessage" });
  assertEquals(resultJson.search, { "/tool": "search" });
});

Deno.test("CellBridge.loadPieceTree keeps schema-backed callables beside populated result fields", async () => {
  const tree = new FsTree();
  const bridge = new CellBridge(tree, "/tmp/ct-exec");

  interface FakeCell {
    schema: Record<string, unknown> | undefined;
    get(): unknown;
    getRaw(): unknown;
    asSchemaFromLinks(): FakeCell;
    key(segment: string): FakeCell;
    isStream?: () => boolean;
  }

  function makeCell(
    value: unknown,
    schema: Record<string, unknown> | undefined,
    children: Record<string, FakeCell> = {},
    options: { isStream?: boolean } = {},
  ): FakeCell {
    return {
      schema,
      get: () => value,
      getRaw: () => value,
      asSchemaFromLinks() {
        return this;
      },
      key(segment: string) {
        return children[segment] ?? makeCell(undefined, undefined);
      },
      isStream: options.isStream ? () => true : undefined,
    };
  }

  const titleCell = makeCell("hello", { type: "string" });
  const handlerCell = makeCell(undefined, undefined, {}, { isStream: true });
  const toolCell = makeCell(
    {
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      extraParams: { source: "bound-source" },
    },
    undefined,
  );
  const resultCell = makeCell(
    { title: "hello" },
    {
      type: "object",
      properties: {
        title: { type: "string" },
        recordMessage: { type: "object" },
        search: { type: "object" },
      },
    },
    {
      title: titleCell,
      recordMessage: handlerCell,
      search: toolCell,
    },
  );

  const piece = {
    id: "of:entity-123",
    name: () => "Mixed Fixture",
    getPatternMeta: () => Promise.resolve({ patternName: "Mixed Fixture" }),
    input: {
      getCell: () =>
        Promise.resolve(
          makeCell(undefined, { type: "object", properties: {} }),
        ),
      get: () => Promise.resolve(undefined),
    },
    result: {
      getCell: () => Promise.resolve(resultCell),
      get: () => Promise.resolve({ title: "hello" }),
    },
  };

  interface MixedPiece {
    id: string;
    name(): string;
    getPatternMeta(): Promise<{ patternName: string }>;
    input: {
      getCell(): Promise<FakeCell>;
      get(): Promise<unknown>;
    };
    result: {
      getCell(): Promise<FakeCell>;
      get(): Promise<unknown>;
    };
  }

  type LoadPieceTree = (
    piece: MixedPiece,
    parentIno: bigint,
    name: string,
    spaceName: string,
  ) => Promise<bigint>;

  const pieceIno = await (bridge as unknown as {
    loadPieceTree: LoadPieceTree;
  }).loadPieceTree(piece, tree.rootIno, "Mixed Fixture", "home");

  const resultIno = tree.lookup(pieceIno, "result");
  assertEquals(resultIno !== undefined, true);
  assertEquals(getFileContent(tree, resultIno!, "title"), "hello");
  assertEquals(
    tree.lookup(resultIno!, "recordMessage.handler") !== undefined,
    true,
  );
  assertEquals(tree.lookup(resultIno!, "search.tool") !== undefined, true);

  const resultJson = JSON.parse(getFileContent(tree, pieceIno, "result.json"));
  assertEquals(resultJson.title, "hello");
  assertEquals(resultJson.recordMessage, { "/handler": "recordMessage" });
  assertEquals(resultJson.search, { "/tool": "search" });
});

// --- parseSymlinkTarget tests ---

/** Helper: build a minimal tree mimicking a space with pieces. */
function buildTestTree(): {
  tree: FsTree;
  bridge: CellBridge;
  resultIno: bigint;
} {
  const tree = new FsTree();
  const bridge = new CellBridge(tree);

  // Build: /myspace/pieces/mypiece/result/
  const spaceIno = tree.addDir(tree.rootIno, "myspace");
  tree.addDir(spaceIno, "entities");
  const piecesIno = tree.addDir(spaceIno, "pieces");
  const pieceIno = tree.addDir(piecesIno, "mypiece");
  const resultIno = tree.addDir(pieceIno, "result", "object");

  // Register known space
  bridge.knownSpaces.set("myspace", "did:key:z6MkMySpace");

  return { tree, bridge, resultIno };
}

Deno.test("parseSymlinkTarget - same-space entity ref", () => {
  const { bridge, resultIno } = buildTestTree();

  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../../../entities/ba4jcbvpq3k5",
  );

  assertEquals(result, { id: "ba4jcbvpq3k5" });
});

Deno.test("parseSymlinkTarget - same-space entity ref with path", () => {
  const { bridge, resultIno } = buildTestTree();

  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../../../entities/ba4jcbvpq3k5/items/0",
  );

  assertEquals(result, { id: "ba4jcbvpq3k5", path: ["items", "0"] });
});

Deno.test("parseSymlinkTarget - cross-space entity ref", () => {
  const { tree, bridge, resultIno } = buildTestTree();

  // Add another space
  const otherIno = tree.addDir(tree.rootIno, "other");
  tree.addDir(otherIno, "entities");
  bridge.knownSpaces.set("other", "did:key:z6MkOther");

  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../../../../other/entities/xyz123",
  );

  assertEquals(result, { id: "xyz123", space: "did:key:z6MkOther" });
});

Deno.test("parseSymlinkTarget - cross-space entity ref with path", () => {
  const { tree, bridge, resultIno } = buildTestTree();

  const otherIno = tree.addDir(tree.rootIno, "other");
  tree.addDir(otherIno, "entities");
  bridge.knownSpaces.set("other", "did:key:z6MkOther");

  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../../../../other/entities/xyz123/name",
  );

  assertEquals(result, {
    id: "xyz123",
    space: "did:key:z6MkOther",
    path: ["name"],
  });
});

Deno.test("parseSymlinkTarget - self-reference within piece", () => {
  const { bridge, resultIno } = buildTestTree();

  // Target points to input/items/0 within the same piece
  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../input/items/0",
  );

  assertEquals(result, { path: ["items", "0"] });
});

Deno.test("parseSymlinkTarget - escapes mount root returns null", () => {
  const { bridge, resultIno } = buildTestTree();

  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../../../../../escape",
  );

  assertEquals(result, null);
});

Deno.test("parseSymlinkTarget - unresolvable target returns null", () => {
  const { bridge, resultIno } = buildTestTree();

  // Resolves to mount root (no entities/ or pieces/ pattern)
  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../../../..",
  );

  assertEquals(result, null);
});

Deno.test("parseSymlinkTarget - unknown cross-space uses name as fallback", () => {
  const { bridge, resultIno } = buildTestTree();

  // "unknown" space isn't in knownSpaces
  const result = bridge.parseSymlinkTarget(
    resultIno,
    "../../../../unknown/entities/abc",
  );

  assertEquals(result, { id: "abc", space: "unknown" });
});
