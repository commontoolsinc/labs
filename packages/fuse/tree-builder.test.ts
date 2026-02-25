// tree-builder.test.ts — Unit tests for JSON-to-tree conversion and symlink parsing
import { assertEquals } from "@std/assert";
import { FsTree } from "./tree.ts";
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

Deno.test("isHandlerCell - detects handler cells and sigil links to internal/*", () => {
  // Live Cell object with _kind="cell" and _link.path starting with "internal"
  assertEquals(
    isHandlerCell({
      _kind: "cell",
      _link: { path: ["internal", "increment"], id: "of:abc" },
      runtime: {},
      tx: 0,
    }),
    true,
  );
  // Live Cell but path is not internal/* — not a handler
  assertEquals(
    isHandlerCell({
      _kind: "cell",
      _link: { path: ["result", "value"], id: "of:abc" },
    }),
    false,
  );
  // Serialized sigil link with path starting with "internal"
  assertEquals(
    isHandlerCell(
      { "/": { "link@1": { id: "of:abc", path: ["internal", "increment"] } } },
    ),
    true,
  );
  // Serialized sigil link, path is not internal/* — not a handler
  assertEquals(
    isHandlerCell(
      { "/": { "link@1": { id: "of:abc", path: ["result", "value"] } } },
    ),
    false,
  );
  // Not a Cell or sigil link at all
  assertEquals(isHandlerCell({ $stream: true }), false);
  assertEquals(isHandlerCell(42), false);
  assertEquals(isHandlerCell(null), false);
});

Deno.test("buildJsonTree - handler cells skipped via skipEntry", () => {
  const tree = new FsTree();

  // Simulate live Cell objects (as returned by piece.result.get())
  const data = {
    value: 10,
    increment: {
      _kind: "cell",
      _link: { path: ["internal", "increment"], id: "of:abc" },
      runtime: {},
      toJSON() {
        return {
          "/": {
            "link@1": { id: "of:abc", path: ["internal", "increment"] },
          },
        };
      },
    },
    decrement: {
      _kind: "cell",
      _link: { path: ["internal", "decrement"], id: "of:abc" },
      runtime: {},
      toJSON() {
        return {
          "/": {
            "link@1": { id: "of:abc", path: ["internal", "decrement"] },
          },
        };
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

Deno.test("FsTree - addHandler creates handler node", () => {
  const tree = new FsTree();
  const dirIno = tree.addDir(tree.rootIno, "result", "object");
  const handlerIno = tree.addHandler(
    dirIno,
    "addItem.handler",
    "addItem",
    "result",
  );

  const node = tree.getNode(handlerIno);
  assertEquals(node?.kind, "handler");
  if (node?.kind === "handler") {
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
  tree.addHandler(dirIno, "addItem.handler", "addItem", "result");
  tree.addHandler(dirIno, "reset.handler", "reset", "result");

  const children = tree.getChildren(dirIno);
  const names = children.map(([name]) => name).sort();
  assertEquals(names, ["addItem.handler", "count", "reset.handler"]);
});

Deno.test("FsTree - clear removes handler nodes", () => {
  const tree = new FsTree();
  const dirIno = tree.addDir(tree.rootIno, "result", "object");
  const handlerIno = tree.addHandler(dirIno, "add.handler", "add", "result");

  tree.clear(dirIno);

  assertEquals(tree.getNode(handlerIno), undefined);
  assertEquals(tree.lookup(tree.rootIno, "result"), undefined);
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
