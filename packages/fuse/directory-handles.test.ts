import { assertEquals, assertRejects } from "@std/assert";
import {
  collectDirectorySnapshot,
  collectVirtualDirectorySnapshot,
  DirectoryHandleMap,
  type DirectoryPreparer,
  type DirectorySnapshotEntry,
  prepareDirectoryForHandle,
} from "./directory-handles.ts";
import { DIR_MODE, DIR_MODE_RW } from "./platform.ts";
import { FsTree } from "./tree.ts";

function countingPreparer(
  calls: bigint[],
  prepare: (ino: bigint) => Promise<boolean> = () => Promise.resolve(true),
): DirectoryPreparer {
  return {
    shouldPrepareDirectory: () => true,
    prepareDirectory: (ino) => {
      calls.push(ino);
      return prepare(ino);
    },
  };
}

Deno.test("directory preparation runs once per open handle", async () => {
  const handles = new DirectoryHandleMap();
  const ino = 42n;
  const calls: bigint[] = [];
  const preparer = countingPreparer(calls);

  const first = handles.open(ino);
  await prepareDirectoryForHandle(handles, first, ino, preparer);
  assertEquals(calls, [ino]);
  assertEquals(
    prepareDirectoryForHandle(handles, first, ino, preparer),
    undefined,
  );
  assertEquals(calls, [ino]);

  handles.close(first);
  const second = handles.open(ino);
  await prepareDirectoryForHandle(handles, second, ino, preparer);
  assertEquals(calls, [ino, ino]);
});

Deno.test("untracked readdir calls preserve per-read preparation", async () => {
  const handles = new DirectoryHandleMap();
  const ino = 42n;
  const calls: bigint[] = [];
  const preparer = countingPreparer(calls);

  await prepareDirectoryForHandle(handles, 0n, ino, preparer);
  await prepareDirectoryForHandle(handles, 0n, ino, preparer);
  assertEquals(calls, [ino, ino]);
});

Deno.test("concurrent reads share one handle preparation", async () => {
  const handles = new DirectoryHandleMap();
  const ino = 42n;
  const fh = handles.open(ino);
  const calls: bigint[] = [];
  const ready = Promise.withResolvers<boolean>();
  const preparer = countingPreparer(calls, () => ready.promise);

  const first = prepareDirectoryForHandle(handles, fh, ino, preparer)!;
  const second = prepareDirectoryForHandle(handles, fh, ino, preparer)!;
  assertEquals(first, second);
  assertEquals(calls, [ino]);

  ready.resolve(true);
  await Promise.all([first, second]);
});

Deno.test("failed directory preparation can be retried", async () => {
  const handles = new DirectoryHandleMap();
  const ino = 42n;
  const fh = handles.open(ino);
  const error = new Error("identifier listing failed");
  let attempts = 0;
  const preparer = countingPreparer([], () => {
    attempts++;
    return attempts === 1 ? Promise.reject(error) : Promise.resolve(true);
  });

  await assertRejects(
    () => prepareDirectoryForHandle(handles, fh, ino, preparer)!,
    Error,
    error.message,
  );
  await prepareDirectoryForHandle(handles, fh, ino, preparer);
  assertEquals(attempts, 2);
});

Deno.test("directory entries remain stable for continuation offsets", () => {
  const handles = new DirectoryHandleMap();
  const ino = 42n;
  const fh = handles.open(ino);
  let liveEntries: DirectorySnapshotEntry[] = [
    { name: "first", ino: 100n, mode: 1 },
    { name: "second", ino: 101n, mode: 1 },
    { name: "third", ino: 102n, mode: 1 },
  ];
  const readEntries = () => liveEntries.slice();

  const firstPage = handles.snapshot(fh, ino, readEntries).slice(0, 2);
  liveEntries = liveEntries.slice(1);
  const continuation = handles.snapshot(fh, ino, readEntries).slice(2);

  assertEquals(firstPage.map(({ name }) => name), ["first", "second"]);
  assertEquals(continuation.map(({ name }) => name), ["third"]);

  handles.close(fh);
  const nextFh = handles.open(ino);
  assertEquals(
    handles.snapshot(nextFh, ino, readEntries).map(({ name }) => name),
    ["second", "third"],
  );
});

Deno.test("prepared virtual entries become the open handle snapshot", async () => {
  const tree = new FsTree();
  const ino = tree.addDir(tree.rootIno, "entities");
  const handles = new DirectoryHandleMap();
  const fh = handles.open(ino);
  const virtual = collectVirtualDirectorySnapshot(tree, ino, [
    "first",
    "second",
  ]);
  const preparer: DirectoryPreparer = {
    shouldPrepareDirectory: () => true,
    prepareDirectory: () => Promise.resolve(true),
    prepareDirectorySnapshot: () => Promise.resolve(virtual),
  };

  assertEquals(
    await prepareDirectoryForHandle(handles, fh, ino, preparer),
    virtual,
  );
  assertEquals(
    handles.snapshot(fh, ino, () => []),
    virtual,
  );
  assertEquals(
    prepareDirectoryForHandle(handles, fh, ino, preparer),
    undefined,
  );
});

Deno.test("directory snapshots capture entry modes", () => {
  const tree = new FsTree(() => 0);
  const parent = tree.addDir(tree.rootIno, "parent");
  const readOnly = tree.addDir(parent, "read-only");
  const writable = tree.addDir(parent, "writable");

  assertEquals(
    collectDirectorySnapshot(tree, parent, (ino) => ino === writable),
    [
      { name: ".", ino: parent, mode: DIR_MODE },
      { name: "..", ino: tree.rootIno, mode: DIR_MODE },
      { name: "read-only", ino: readOnly, mode: DIR_MODE },
      { name: "writable", ino: writable, mode: DIR_MODE_RW },
    ],
  );
});

Deno.test("untracked directory reads use the current entries", () => {
  const handles = new DirectoryHandleMap();
  const ino = 42n;
  let name = "first";
  const readEntries = (): DirectorySnapshotEntry[] => [
    { name, ino: 100n, mode: 1 },
  ];

  assertEquals(handles.snapshot(0n, ino, readEntries)[0].name, "first");
  name = "second";
  assertEquals(handles.snapshot(0n, ino, readEntries)[0].name, "second");
});
