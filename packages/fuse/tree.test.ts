// tree.test.ts — Unit tests for FsTree
import { assertEquals } from "@std/assert";
import { FsTree } from "./tree.ts";

const decoder = new TextDecoder();

Deno.test("addDir round-trip", () => {
  const tree = new FsTree();
  const ino = tree.addDir(tree.rootIno, "mydir");
  assertEquals(tree.lookup(tree.rootIno, "mydir"), ino);
  const node = tree.getNode(ino);
  assertEquals(node?.kind, "dir");
});

Deno.test("addFile round-trip with string content", () => {
  const tree = new FsTree();
  const ino = tree.addFile(tree.rootIno, "hello.txt", "hello world", "string");
  assertEquals(tree.lookup(tree.rootIno, "hello.txt"), ino);
  const node = tree.getNode(ino);
  assertEquals(node?.kind, "file");
  if (node?.kind === "file") {
    assertEquals(decoder.decode(node.content), "hello world");
    assertEquals(node.jsonType, "string");
  }
});

Deno.test("addFile with Uint8Array content", () => {
  const tree = new FsTree();
  const bytes = new TextEncoder().encode("hello world");
  const ino = tree.addFile(tree.rootIno, "hello.txt", bytes, "string");
  const node = tree.getNode(ino);
  assertEquals(node?.kind, "file");
  if (node?.kind === "file") {
    assertEquals(decoder.decode(node.content), "hello world");
  }
});

Deno.test("getPath for deeply nested dir", () => {
  const tree = new FsTree();
  const a = tree.addDir(tree.rootIno, "a");
  const b = tree.addDir(a, "b");
  const c = tree.addDir(b, "c");
  assertEquals(tree.getPath(c), "/a/b/c");
});

Deno.test("rename within same parent", () => {
  const tree = new FsTree();
  const ino = tree.addDir(tree.rootIno, "original");
  tree.rename(tree.rootIno, "original", tree.rootIno, "renamed");
  assertEquals(tree.lookup(tree.rootIno, "original"), undefined);
  assertEquals(tree.lookup(tree.rootIno, "renamed"), ino);
  assertEquals(tree.getPath(ino), "/renamed");
});

Deno.test("rename across parents updates paths transitively", () => {
  const tree = new FsTree();
  const src = tree.addDir(tree.rootIno, "src");
  const dst = tree.addDir(tree.rootIno, "dst");
  const child = tree.addDir(src, "child");
  const grandchild = tree.addFile(child, "file.txt", "data", "string");

  tree.rename(src, "child", dst, "child");

  assertEquals(tree.lookup(src, "child"), undefined);
  assertEquals(tree.lookup(dst, "child"), child);
  assertEquals(tree.getPath(child), "/dst/child");
  assertEquals(tree.getPath(grandchild), "/dst/child/file.txt");
});

Deno.test("rename onto existing name clears target, no orphan inodes", () => {
  const tree = new FsTree();
  const a = tree.addDir(tree.rootIno, "a");
  const b = tree.addDir(tree.rootIno, "b");
  const sizeBeforeRename = tree.inodes.size;

  // rename "a" onto "b" — "b" should be cleared
  tree.rename(tree.rootIno, "a", tree.rootIno, "b");

  // "b" ino is gone, "a" ino now lives under name "b"
  assertEquals(tree.inodes.has(b), false);
  assertEquals(tree.lookup(tree.rootIno, "b"), a);
  // inodes map decreased by 1 (the cleared "b" node)
  assertEquals(tree.inodes.size, sizeBeforeRename - 1);
});

Deno.test("removeChild clears dir and nested file recursively", () => {
  const tree = new FsTree();
  const dir = tree.addDir(tree.rootIno, "dir");
  const file = tree.addFile(dir, "nested.txt", "content", "string");

  tree.removeChild(tree.rootIno, "dir");

  assertEquals(tree.inodes.has(dir), false);
  assertEquals(tree.inodes.has(file), false);
  assertEquals(tree.lookup(tree.rootIno, "dir"), undefined);
});

Deno.test("clear removes subtree but keeps sibling", () => {
  const tree = new FsTree();
  const a = tree.addDir(tree.rootIno, "a");
  const b = tree.addDir(tree.rootIno, "b");
  const aChild = tree.addFile(a, "f.txt", "x", "string");

  tree.clear(a);

  assertEquals(tree.inodes.has(a), false);
  assertEquals(tree.inodes.has(aChild), false);
  // sibling "b" is unaffected
  assertEquals(tree.lookup(tree.rootIno, "b"), b);
  assertEquals(tree.inodes.has(b), true);
});

Deno.test("getNameForIno returns the registered child name", () => {
  const tree = new FsTree();
  const ino = tree.addFile(tree.rootIno, "myfile.txt", "data", "string");
  assertEquals(tree.getNameForIno(ino), "myfile.txt");
});
