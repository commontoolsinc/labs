/**
 * The real {@link realFileGateway}: a thin port over Deno's filesystem used by
 * the `cf view` file picker. These tests drive it against a temp directory on
 * the actual disk so every branch — successful reads, the catch arms when a
 * path does not exist, and the symlink-resolving directory check — runs.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { realFileGateway } from "../lib/view/filegateway.ts";

/** Make a fresh temp directory and ensure it is removed after `fn` runs. */
async function withTempDir(
  fn: (dir: string) => void | Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "cf-filegateway-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("realFileGateway.cwd: returns Deno's working directory", () => {
  const gw = realFileGateway();
  assertEquals(gw.cwd(), Deno.cwd());
});

Deno.test("realFileGateway.cwd: falls back to '.' when Deno.cwd throws", () => {
  // The gateway calls Deno.cwd() at invocation time. Swapping it for a throwing
  // stub drives the catch arm, which yields the relative "." as a last resort.
  const gw = realFileGateway();
  const original = Deno.cwd;
  try {
    (Deno as { cwd: () => string }).cwd = () => {
      throw new Deno.errors.NotCapable("read access denied");
    };
    assertEquals(gw.cwd(), ".");
  } finally {
    (Deno as { cwd: () => string }).cwd = original;
  }
});

Deno.test("realFileGateway.list: reads a directory's entries with isDir flags", async () => {
  await withTempDir((dir) => {
    Deno.mkdirSync(join(dir, "sub"));
    Deno.writeTextFileSync(join(dir, "a.ts"), "const a = 1;\n");

    const gw = realFileGateway();
    const entries = gw.list(dir);
    assert(entries !== null, "directory should be readable");
    const byName = new Map(entries!.map((e) => [e.name, e.isDir]));
    assertEquals(byName.get("sub"), true, "plain directory is a dir");
    assertEquals(byName.get("a.ts"), false, "plain file is not a dir");
  });
});

Deno.test("realFileGateway.list: returns null when the directory cannot be read", () => {
  const gw = realFileGateway();
  const missing = join(Deno.cwd(), "definitely-not-a-real-dir-xyz-12345");
  assertEquals(gw.list(missing), null);
});

Deno.test("realFileGateway.list: a symlink to a directory is reported as a dir", async () => {
  await withTempDir((dir) => {
    Deno.mkdirSync(join(dir, "realdir"));
    Deno.symlinkSync(join(dir, "realdir"), join(dir, "dirlink"));

    const gw = realFileGateway();
    const entries = gw.list(dir);
    assert(entries !== null);
    const byName = new Map(entries!.map((e) => [e.name, e.isDir]));
    assertEquals(
      byName.get("dirlink"),
      true,
      "symlink resolving to a directory is offered as a directory",
    );
  });
});

Deno.test("realFileGateway.list: a symlink to a file is not a dir", async () => {
  await withTempDir((dir) => {
    Deno.writeTextFileSync(join(dir, "target.ts"), "const x = 1;\n");
    Deno.symlinkSync(join(dir, "target.ts"), join(dir, "filelink"));

    const gw = realFileGateway();
    const entries = gw.list(dir);
    assert(entries !== null);
    const byName = new Map(entries!.map((e) => [e.name, e.isDir]));
    assertEquals(
      byName.get("filelink"),
      false,
      "symlink resolving to a file is not a directory",
    );
  });
});

Deno.test("realFileGateway.list: a broken symlink is not a dir", async () => {
  await withTempDir((dir) => {
    // Point at a path that does not exist so statSync throws and the
    // isDir helper's catch arm returns false.
    Deno.symlinkSync(join(dir, "nonexistent-target"), join(dir, "broken"));

    const gw = realFileGateway();
    const entries = gw.list(dir);
    assert(entries !== null);
    const byName = new Map(entries!.map((e) => [e.name, e.isDir]));
    assertEquals(
      byName.get("broken"),
      false,
      "a dangling symlink cannot be a directory",
    );
  });
});

Deno.test("realFileGateway.open: reads a file into an editable source and its text", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "doc.ts");
    const contents = "export const greeting = 'hi';\n";
    Deno.writeTextFileSync(path, contents);

    const gw = realFileGateway();
    const opened = gw.open(path);
    assert(opened !== null, "an existing file opens");
    assertEquals(opened!.text, contents);
    assertEquals(opened!.source.editable, true);
    assertEquals(opened!.source.path, path);
    assertEquals(opened!.source.label, "doc.ts");
  });
});

Deno.test("realFileGateway.open: returns null when the file cannot be read", () => {
  const gw = realFileGateway();
  const missing = join(Deno.cwd(), "definitely-not-a-real-file-xyz-12345.ts");
  assertEquals(gw.open(missing), null);
});

Deno.test("realFileGateway.join: joins and normalises a directory and segment", () => {
  const gw = realFileGateway();
  assertEquals(gw.join("/work", "a.ts"), join("/work", "a.ts"));
  assertEquals(gw.join("/work/sub", ".."), join("/work/sub", ".."));
});

Deno.test("realFileGateway.parent: returns the parent directory", () => {
  const gw = realFileGateway();
  assertEquals(gw.parent("/work/sub/a.ts"), "/work/sub");
});

Deno.test("realFileGateway.base: returns the final path segment", () => {
  const gw = realFileGateway();
  assertEquals(gw.base("/work/sub/a.ts"), "a.ts");
});
