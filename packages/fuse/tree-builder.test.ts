// tree-builder.test.ts — Unit tests for JSON-to-tree conversion
import { assertEquals } from "@std/assert";
import { FsTree } from "./tree.ts";
import { buildJsonTree, isSigilLink, safeStringify } from "./tree-builder.ts";

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
