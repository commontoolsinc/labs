// tree.test.ts — Unit tests for FsTree
import { assertEquals } from "@std/assert";
import { CfcProjectionAnnotator } from "./annotations.ts";
import { FsTree } from "./tree.ts";
import type { JsonType } from "./types.ts";

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

Deno.test("rename carries CFC directory entry annotation to the new name", () => {
  const tree = new FsTree();
  const annotator = new CfcProjectionAnnotator(tree, {
    space: "did:key:zSpace",
    entity: "of:piece",
    rootKind: "pieces",
    cell: "result",
    generation: "generation-1",
    labelView: {
      version: 1,
      entries: [{
        path: ["title"],
        label: { confidentiality: [{ type: "test-label", value: "secret" }] },
      }],
    },
  });
  const parentIno = tree.addDir(tree.rootIno, "result", "object");
  annotator.annotateJsonDirectory(parentIno, [], { title: "old" });
  const childIno = tree.addFile(parentIno, "title", "old", "string");
  annotator.annotateJsonScalar(childIno, ["title"], "old");
  annotator.annotateEntry(parentIno, "title", childIno, {
    labelPath: ["title"],
  });

  tree.rename(parentIno, "title", parentIno, "renamed");

  const entries = tree.getCfcAnnotation(parentIno)?.entries?.entries;
  assertEquals(entries?.map((entry) => entry.name), ["renamed"]);
  assertEquals(entries?.[0].kind, "file");
  assertEquals(entries?.[0].childRef, tree.getCfcAnnotation(childIno)?.ref);
  assertEquals(entries?.[0].nameDigest.startsWith("fnv1a32:"), true);
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

// --- transplantSubtree ---------------------------------------------------

type BuildSpec =
  | { file: string; jsonType?: JsonType }
  | { symlink: string }
  | { dir: Record<string, BuildSpec>; jsonType?: "object" | "array" };

/** Build a subtree from a compact spec so transplant tests stay readable. */
function build(
  tree: FsTree,
  parent: bigint,
  name: string,
  spec: BuildSpec,
): bigint {
  if ("file" in spec) {
    return tree.addFile(parent, name, spec.file, spec.jsonType ?? "string");
  }
  if ("symlink" in spec) {
    return tree.addSymlink(parent, name, spec.symlink);
  }
  const dirIno = tree.addDir(parent, name, spec.jsonType ?? "object");
  for (const [childName, childSpec] of Object.entries(spec.dir)) {
    build(tree, dirIno, childName, childSpec);
  }
  return dirIno;
}

Deno.test("transplant keeps the inode of a path that survives unchanged", () => {
  const tree = new FsTree();
  const oldIno = build(tree, tree.rootIno, "input", {
    dir: { title: { file: "hello" }, count: { file: "1", jsonType: "number" } },
  });
  const oldTitleIno = tree.lookup(oldIno, "title")!;
  const oldCountIno = tree.lookup(oldIno, "count")!;

  const pendingIno = build(tree, tree.rootIno, ".input.pending", {
    dir: { title: { file: "hello" }, count: { file: "1", jsonType: "number" } },
  });

  const changes = tree.transplantSubtree(oldIno, pendingIno);

  // The survivor keeps its inodes at their original path.
  assertEquals(tree.lookup(tree.rootIno, "input"), oldIno);
  assertEquals(tree.lookup(oldIno, "title"), oldTitleIno);
  assertEquals(tree.lookup(oldIno, "count"), oldCountIno);
  // Nothing changed, so no cache invalidation is reported.
  assertEquals(changes.changedInodes.size, 0);
  assertEquals(changes.entryChanges.size, 0);
  // The staging root is gone.
  assertEquals(tree.lookup(tree.rootIno, ".input.pending"), undefined);
  assertEquals(tree.inodes.has(pendingIno), false);
});

Deno.test("transplant preserves the inode but reports a changed value", () => {
  const tree = new FsTree();
  const oldIno = build(tree, tree.rootIno, "input", {
    dir: { title: { file: "old" }, count: { file: "1", jsonType: "number" } },
  });
  const oldTitleIno = tree.lookup(oldIno, "title")!;
  const oldCountIno = tree.lookup(oldIno, "count")!;

  const pendingIno = build(tree, tree.rootIno, ".input.pending", {
    dir: { title: { file: "new" }, count: { file: "1", jsonType: "number" } },
  });

  const changes = tree.transplantSubtree(oldIno, pendingIno);

  assertEquals(tree.lookup(oldIno, "title"), oldTitleIno);
  const titleNode = tree.getNode(oldTitleIno);
  assertEquals(titleNode?.kind, "file");
  if (titleNode?.kind === "file") {
    assertEquals(decoder.decode(titleNode.content), "new");
  }
  // Only the changed file is reported; the untouched sibling is not.
  assertEquals([...changes.changedInodes], [oldTitleIno]);
  assertEquals(changes.changedInodes.has(oldCountIno), false);
  assertEquals(changes.entryChanges.size, 0);
});

Deno.test("transplant allocates a new inode for an added path", () => {
  const tree = new FsTree();
  const oldIno = build(tree, tree.rootIno, "input", {
    dir: { title: { file: "hello" } },
  });
  const oldTitleIno = tree.lookup(oldIno, "title")!;

  const pendingIno = build(tree, tree.rootIno, ".input.pending", {
    dir: { title: { file: "hello" }, extra: { file: "brand new" } },
  });
  const pendingExtraIno = tree.lookup(pendingIno, "extra")!;

  const changes = tree.transplantSubtree(oldIno, pendingIno);

  // Surviving path keeps its inode; the added path keeps its fresh inode.
  assertEquals(tree.lookup(oldIno, "title"), oldTitleIno);
  const extraIno = tree.lookup(oldIno, "extra");
  assertEquals(extraIno, pendingExtraIno);
  assertEquals(tree.getPath(extraIno!), "/input/extra");
  // Only the parent's "extra" entry changed.
  assertEquals(changes.entryChanges.get(oldIno), new Set(["extra"]));
  assertEquals(changes.changedInodes.size, 0);
});

Deno.test("transplant frees the inode of a removed path", () => {
  const tree = new FsTree();
  const oldIno = build(tree, tree.rootIno, "input", {
    dir: { title: { file: "hello" }, gone: { file: "removed" } },
  });
  const oldGoneIno = tree.lookup(oldIno, "gone")!;

  const pendingIno = build(tree, tree.rootIno, ".input.pending", {
    dir: { title: { file: "hello" } },
  });

  const changes = tree.transplantSubtree(oldIno, pendingIno);

  assertEquals(tree.lookup(oldIno, "gone"), undefined);
  assertEquals(tree.inodes.has(oldGoneIno), false);
  assertEquals(changes.entryChanges.get(oldIno), new Set(["gone"]));
});

Deno.test("transplant allocates a new inode when a path changes kind", () => {
  const tree = new FsTree();
  const oldIno = build(tree, tree.rootIno, "input", {
    dir: { data: { file: "scalar" } },
  });
  const oldDataIno = tree.lookup(oldIno, "data")!;

  // "data" goes from a file to a directory.
  const pendingIno = build(tree, tree.rootIno, ".input.pending", {
    dir: { data: { dir: { nested: { file: "x" } } } },
  });
  const pendingDataIno = tree.lookup(pendingIno, "data")!;

  const changes = tree.transplantSubtree(oldIno, pendingIno);

  const dataIno = tree.lookup(oldIno, "data");
  assertEquals(dataIno, pendingDataIno);
  assertEquals(dataIno === oldDataIno, false);
  assertEquals(tree.inodes.has(oldDataIno), false);
  assertEquals(tree.getNode(dataIno!)?.kind, "dir");
  assertEquals(
    tree.getPath(tree.lookup(dataIno!, "nested")!),
    "/input/data/nested",
  );
  assertEquals(changes.entryChanges.get(oldIno), new Set(["data"]));
});

Deno.test("transplant preserves inodes through unchanged nested directories", () => {
  const tree = new FsTree();
  const oldIno = build(tree, tree.rootIno, "input", {
    dir: {
      a: { dir: { b: { dir: { c: { file: "deep" } } } } },
    },
  });
  const oldA = tree.lookup(oldIno, "a")!;
  const oldB = tree.lookup(oldA, "b")!;
  const oldC = tree.lookup(oldB, "c")!;

  const pendingIno = build(tree, tree.rootIno, ".input.pending", {
    dir: {
      a: { dir: { b: { dir: { c: { file: "deep" } } } } },
    },
  });

  const inodeCountBefore = tree.inodes.size;
  const changes = tree.transplantSubtree(oldIno, pendingIno);

  assertEquals(tree.lookup(oldIno, "a"), oldA);
  assertEquals(tree.lookup(oldA, "b"), oldB);
  assertEquals(tree.lookup(oldB, "c"), oldC);
  assertEquals(changes.changedInodes.size, 0);
  assertEquals(changes.entryChanges.size, 0);
  // The four staging inodes (.input.pending and a/b/c) are freed; nothing
  // else leaks.
  assertEquals(tree.inodes.size, inodeCountBefore - 4);
});

Deno.test("transplant preserves a directory inode across an object/array flip", () => {
  const tree = new FsTree();
  const oldIno = build(tree, tree.rootIno, "input", {
    dir: { items: { dir: { "0": { file: "a" } }, jsonType: "object" } },
  });
  const oldItemsIno = tree.lookup(oldIno, "items")!;

  const pendingIno = build(tree, tree.rootIno, ".input.pending", {
    dir: { items: { dir: { "0": { file: "a" } }, jsonType: "array" } },
  });

  tree.transplantSubtree(oldIno, pendingIno);

  const itemsIno = tree.lookup(oldIno, "items");
  assertEquals(itemsIno, oldItemsIno);
  const itemsNode = tree.getNode(itemsIno!);
  assertEquals(itemsNode?.kind, "dir");
  if (itemsNode?.kind === "dir") {
    assertEquals(itemsNode.jsonType, "array");
  }
});

Deno.test("transplant adopts a changed symlink target", () => {
  const tree = new FsTree();
  const oldIno = build(tree, tree.rootIno, "input", {
    dir: { link: { symlink: "../old/target" } },
  });
  const oldLinkIno = tree.lookup(oldIno, "link")!;

  const pendingIno = build(tree, tree.rootIno, ".input.pending", {
    dir: { link: { symlink: "../new/target" } },
  });

  const changes = tree.transplantSubtree(oldIno, pendingIno);

  assertEquals(tree.lookup(oldIno, "link"), oldLinkIno);
  const linkNode = tree.getNode(oldLinkIno);
  assertEquals(linkNode?.kind, "symlink");
  if (linkNode?.kind === "symlink") {
    assertEquals(linkNode.target, "../new/target");
  }
  assertEquals([...changes.changedInodes], [oldLinkIno]);
});

Deno.test("transplant adopts a changed callable script", () => {
  const tree = new FsTree();
  const oldIno = tree.addDir(tree.rootIno, "result", "object");
  const oldCallableIno = tree.addCallable(
    oldIno,
    "run.handler",
    "handler",
    "cellKey",
    "result",
    new TextEncoder().encode("old script"),
  );

  const pendingIno = tree.addDir(tree.rootIno, ".result.pending", "object");
  tree.addCallable(
    pendingIno,
    "run.handler",
    "handler",
    "cellKey",
    "result",
    new TextEncoder().encode("new script"),
  );

  const changes = tree.transplantSubtree(oldIno, pendingIno);

  assertEquals(tree.lookup(oldIno, "run.handler"), oldCallableIno);
  const node = tree.getNode(oldCallableIno);
  assertEquals(node?.kind, "callable");
  if (node?.kind === "callable") {
    assertEquals(new TextDecoder().decode(node.script), "new script");
  }
  assertEquals([...changes.changedInodes], [oldCallableIno]);
});

Deno.test("transplant throws when the roots differ in kind", () => {
  const tree = new FsTree();
  const dirIno = tree.addDir(tree.rootIno, "input", "object");
  const fileIno = tree.addFile(tree.rootIno, ".input.pending", "x", "string");

  let threw = false;
  try {
    tree.transplantSubtree(dirIno, fileIno);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("transplant removes a vanished child's CFC directory entry", () => {
  const tree = new FsTree();
  const annotator = new CfcProjectionAnnotator(tree, {
    space: "did:key:zSpace",
    entity: "of:piece",
    rootKind: "pieces",
    cell: "result",
    generation: "generation-1",
    labelView: { version: 1, entries: [] },
  });

  const oldIno = tree.addDir(tree.rootIno, "result", "object");
  annotator.annotateJsonDirectory(oldIno, [], { keep: "a", gone: "b" });
  const keepIno = tree.addFile(oldIno, "keep", "a", "string");
  annotator.annotateJsonScalar(keepIno, ["keep"], "a");
  annotator.annotateEntry(oldIno, "keep", keepIno);
  const goneIno = tree.addFile(oldIno, "gone", "b", "string");
  annotator.annotateJsonScalar(goneIno, ["gone"], "b");
  annotator.annotateEntry(oldIno, "gone", goneIno);

  // Rebuild without "gone".
  const pendingIno = tree.addDir(tree.rootIno, ".result.pending", "object");
  annotator.annotateJsonDirectory(pendingIno, [], { keep: "a" });
  const pendingKeepIno = tree.addFile(pendingIno, "keep", "a", "string");
  annotator.annotateJsonScalar(pendingKeepIno, ["keep"], "a");
  annotator.annotateEntry(pendingIno, "keep", pendingKeepIno);

  tree.transplantSubtree(oldIno, pendingIno);

  const entries = tree.getCfcAnnotation(oldIno)?.entries?.entries;
  assertEquals(entries?.map((entry) => entry.name), ["keep"]);
});

// --- mtime tracking ------------------------------------------------------

Deno.test("a node records the clock time it was created at", () => {
  let clock = 1_000;
  const tree = new FsTree(() => clock);
  clock = 2_000;
  const ino = tree.addFile(tree.rootIno, "f", "hi", "string");
  assertEquals(tree.getNode(ino)?.mtime, 2_000);
});

Deno.test("updateFile advances mtime only when the content changes", () => {
  let clock = 1_000;
  const tree = new FsTree(() => clock);
  const ino = tree.addFile(tree.rootIno, "f", "hi", "string");
  assertEquals(tree.getNode(ino)?.mtime, 1_000);

  clock = 2_000;
  tree.updateFile(ino, "hi", "string"); // same bytes
  assertEquals(tree.getNode(ino)?.mtime, 1_000);

  clock = 3_000;
  tree.updateFile(ino, "bye", "string"); // changed
  assertEquals(tree.getNode(ino)?.mtime, 3_000);
});

Deno.test("transplant advances mtime for a changed file but not an unchanged one", () => {
  let clock = 1_000;
  const tree = new FsTree(() => clock);
  const oldIno = build(tree, tree.rootIno, "input", {
    dir: { title: { file: "old" }, count: { file: "1", jsonType: "number" } },
  });
  const titleIno = tree.lookup(oldIno, "title")!;
  const countIno = tree.lookup(oldIno, "count")!;

  clock = 5_000;
  const pendingIno = build(tree, tree.rootIno, ".input.pending", {
    dir: { title: { file: "new" }, count: { file: "1", jsonType: "number" } },
  });
  tree.transplantSubtree(oldIno, pendingIno);

  // The changed file's mtime advances to the transplant time; the unchanged
  // sibling keeps its original mtime.
  assertEquals(tree.getNode(titleIno)?.mtime, 5_000);
  assertEquals(tree.getNode(countIno)?.mtime, 1_000);
});

Deno.test("transplant advances a directory's mtime when its entries change", () => {
  let clock = 1_000;
  const tree = new FsTree(() => clock);
  const oldIno = build(tree, tree.rootIno, "input", {
    dir: { keep: { file: "a" } },
  });

  clock = 5_000;
  const pendingIno = build(tree, tree.rootIno, ".input.pending", {
    dir: { keep: { file: "a" }, added: { file: "b" } },
  });
  tree.transplantSubtree(oldIno, pendingIno);

  // The directory gained an entry, so its mtime advances.
  assertEquals(tree.getNode(oldIno)?.mtime, 5_000);
});

Deno.test("transplant leaves a directory's mtime alone when only a child's content changes", () => {
  let clock = 1_000;
  const tree = new FsTree(() => clock);
  const oldIno = build(tree, tree.rootIno, "input", {
    dir: { title: { file: "old" } },
  });

  clock = 5_000;
  const pendingIno = build(tree, tree.rootIno, ".input.pending", {
    dir: { title: { file: "new" } },
  });
  tree.transplantSubtree(oldIno, pendingIno);

  // The directory's own entry set is unchanged, so its mtime is preserved even
  // though a child's content changed.
  assertEquals(tree.getNode(oldIno)?.mtime, 1_000);
});

Deno.test("mtime advances strictly even when the clock does not move", () => {
  const clock = 1_000; // never advances
  const tree = new FsTree(() => clock);
  const ino = tree.addFile(tree.rootIno, "f", "a", "string");
  assertEquals(tree.getNode(ino)?.mtime, 1_000);

  tree.updateFile(ino, "b", "string");
  assertEquals(tree.getNode(ino)?.mtime, 1_001);

  tree.updateFile(ino, "c", "string");
  assertEquals(tree.getNode(ino)?.mtime, 1_002);
});

Deno.test("touch advances a directory's mtime, clamped strictly upward", () => {
  const clock = 1_000; // does not advance
  const tree = new FsTree(() => clock);
  const dir = tree.addDir(tree.rootIno, "dir");
  assertEquals(tree.getNode(dir)?.mtime, 1_000);

  tree.touch(dir);
  assertEquals(tree.getNode(dir)?.mtime, 1_001);
  tree.touch(dir);
  assertEquals(tree.getNode(dir)?.mtime, 1_002);

  // Touching a missing inode is a no-op.
  tree.touch(9_999n);
});
