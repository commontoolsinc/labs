// tree-builder.test.ts — Unit tests for JSON-to-tree conversion
import { assertEquals } from "@std/assert";
import { FsTree } from "./tree.ts";
import { buildJsonTree } from "./tree-builder.ts";

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
