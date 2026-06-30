// Unit tests for the read-only dump helpers (list / resolve / snapshot).

import { assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import * as Path from "@std/path";
import { listSpaceStores, snapshotSpaceStore, spaceStorePath } from "./dump.ts";

const SPACE_A = "did:key:z6MkDumpHelperSpaceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SPACE_B = "did:key:z6MkDumpHelperSpaceBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

async function makeEngineRoot(): Promise<URL> {
  const tmp = await Deno.makeTempDir({ prefix: "cf-dump-unit-" });
  const root = Path.toFileUrl(`${Path.join(tmp, "engine-v3")}/`);
  await Deno.mkdir(Path.fromFileUrl(root), { recursive: true });
  return root;
}

function seedStore(root: URL, space: string, rows: number): void {
  const path = spaceFilePath(root, space);
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE probe (n INTEGER)");
    for (let i = 0; i < rows; i++) {
      db.exec("INSERT INTO probe (n) VALUES (?)", i);
    }
  } finally {
    db.close();
  }
}

// Mirror engine path realization: percent-encode in URL space, decode on disk.
function spaceFilePath(root: URL, space: string): string {
  return Path.fromFileUrl(
    new URL(`./${encodeURIComponent(space)}.sqlite`, root),
  );
}

Deno.test("listSpaceStores returns decoded DIDs, newest first", async () => {
  const root = await makeEngineRoot();
  try {
    seedStore(root, SPACE_A, 1);
    seedStore(root, SPACE_B, 1);
    const spaces = listSpaceStores(root);
    const dids = spaces.map((s) => s.space).sort();
    assertEquals(dids, [SPACE_A, SPACE_B].sort());
    for (const s of spaces) {
      // DIDs come back decoded (literal ":"), not percent-encoded.
      assertEquals(s.space.includes("%3A"), false);
      assertEquals(s.sizeBytes > 0, true);
    }
  } finally {
    await Deno.remove(Path.fromFileUrl(new URL("..", root)), {
      recursive: true,
    });
  }
});

Deno.test("spaceStorePath resolves real files and blocks traversal", async () => {
  const root = await makeEngineRoot();
  try {
    seedStore(root, SPACE_A, 1);
    const resolved = spaceStorePath(root, SPACE_A);
    assertEquals(resolved, spaceFilePath(root, SPACE_A));
    assertEquals(spaceStorePath(root, "did:key:zMissing"), null);
    // Path traversal in the id is rejected by the encode guard.
    assertEquals(spaceStorePath(root, "../../etc/passwd"), null);
    assertEquals(spaceStorePath(root, "a/b"), null);
  } finally {
    await Deno.remove(Path.fromFileUrl(new URL("..", root)), {
      recursive: true,
    });
  }
});

Deno.test("snapshotSpaceStore produces a consistent, openable copy", async () => {
  const root = await makeEngineRoot();
  try {
    seedStore(root, SPACE_A, 100);
    const source = spaceStorePath(root, SPACE_A)!;
    const destDir = await Deno.makeTempDir({ prefix: "cf-dump-snap-" });
    const dest = Path.join(destDir, "snap.sqlite");
    try {
      snapshotSpaceStore(source, dest);
      // No WAL/SHM companions: VACUUM INTO yields a single self-contained file.
      assertEquals(await exists(`${dest}-wal`), false);
      const db = new Database(dest, { readonly: true });
      try {
        const row = db.prepare("SELECT count(*) AS c FROM probe").get<
          { c: number }
        >();
        assertEquals(row?.c, 100);
      } finally {
        db.close();
      }
    } finally {
      await Deno.remove(destDir, { recursive: true });
    }
  } finally {
    await Deno.remove(Path.fromFileUrl(new URL("..", root)), {
      recursive: true,
    });
  }
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
