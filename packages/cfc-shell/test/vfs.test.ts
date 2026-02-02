/**
 * Tests for Virtual Filesystem (VFS)
 */

import { assertEquals, assertThrows } from "@std/assert";
import { VFS } from "../src/vfs.ts";
import { expandGlob, matchGlob } from "../src/glob.ts";
import { labels } from "../src/labels.ts";

// ============================================================================
// Basic File Operations
// ============================================================================

Deno.test("VFS: create file and read it back", () => {
  const vfs = new VFS();
  const label = labels.userInput();
  const content = "Hello, World!";

  vfs.writeFile("/test.txt", content, label);
  const result = vfs.readFileText("/test.txt");

  assertEquals(result.value, content);
  assertEquals(result.label, label);
});

Deno.test("VFS: write file auto-creates parent directories", () => {
  const vfs = new VFS();
  const label = labels.bottom();

  vfs.writeFile("/a/b/c/test.txt", "content", label);

  assertEquals(vfs.exists("/a"), true);
  assertEquals(vfs.exists("/a/b"), true);
  assertEquals(vfs.exists("/a/b/c"), true);
  assertEquals(vfs.exists("/a/b/c/test.txt"), true);

  const result = vfs.readFileText("/a/b/c/test.txt");
  assertEquals(result.value, "content");
});

Deno.test("VFS: read nonexistent file throws", () => {
  const vfs = new VFS();

  assertThrows(
    () => vfs.readFile("/nonexistent.txt"),
    Error,
    "No such file",
  );
});

Deno.test("VFS: write binary content", () => {
  const vfs = new VFS();
  const label = labels.bottom();
  const content = new Uint8Array([1, 2, 3, 4, 5]);

  vfs.writeFile("/binary.dat", content, label);
  const result = vfs.readFile("/binary.dat");

  assertEquals(result.value, content);
  assertEquals(result.label, label);
});

// ============================================================================
// Directory Operations
// ============================================================================

Deno.test("VFS: readdir lists children with directory label", () => {
  const vfs = new VFS();
  const _dirLabel = labels.userInput();

  vfs.mkdir("/mydir");
  vfs.writeFile("/mydir/file1.txt", "content1", labels.bottom());
  vfs.writeFile("/mydir/file2.txt", "content2", labels.bottom());
  vfs.mkdir("/mydir/subdir");

  const result = vfs.readdir("/mydir");

  assertEquals(
    result.value.sort(),
    ["file1.txt", "file2.txt", "subdir"].sort(),
  );
});

Deno.test("VFS: mkdir creates directory", () => {
  const vfs = new VFS();

  vfs.mkdir("/testdir");

  assertEquals(vfs.exists("/testdir"), true);

  const node = vfs.resolve("/testdir", true);
  assertEquals(node?.kind, "directory");
});

Deno.test("VFS: mkdir recursive creates nested paths", () => {
  const vfs = new VFS();

  vfs.mkdir("/a/b/c/d", true);

  assertEquals(vfs.exists("/a"), true);
  assertEquals(vfs.exists("/a/b"), true);
  assertEquals(vfs.exists("/a/b/c"), true);
  assertEquals(vfs.exists("/a/b/c/d"), true);
});

Deno.test("VFS: mkdir non-recursive throws if parent missing", () => {
  const vfs = new VFS();

  assertThrows(
    () => vfs.mkdir("/a/b/c"),
    Error,
    "No such file or directory",
  );
});

// ============================================================================
// Remove Operations
// ============================================================================

Deno.test("VFS: rm removes file", () => {
  const vfs = new VFS();

  vfs.writeFile("/test.txt", "content", labels.bottom());
  assertEquals(vfs.exists("/test.txt"), true);

  vfs.rm("/test.txt");
  assertEquals(vfs.exists("/test.txt"), false);
});

Deno.test("VFS: rm recursive removes directories", () => {
  const vfs = new VFS();

  vfs.mkdir("/dir/subdir", true);
  vfs.writeFile("/dir/file.txt", "content", labels.bottom());
  vfs.writeFile("/dir/subdir/nested.txt", "content", labels.bottom());

  vfs.rm("/dir", true);

  assertEquals(vfs.exists("/dir"), false);
});

Deno.test("VFS: rm non-recursive throws on non-empty directory", () => {
  const vfs = new VFS();

  vfs.mkdir("/dir");
  vfs.writeFile("/dir/file.txt", "content", labels.bottom());

  assertThrows(
    () => vfs.rm("/dir"),
    Error,
    "Directory not empty",
  );
});

Deno.test("VFS: rm allows removing empty directory", () => {
  const vfs = new VFS();

  vfs.mkdir("/emptydir");
  vfs.rm("/emptydir");

  assertEquals(vfs.exists("/emptydir"), false);
});

// ============================================================================
// Copy and Move Operations
// ============================================================================

Deno.test("VFS: cp copies content and label", () => {
  const vfs = new VFS();
  const label = labels.userInput();
  const content = "test content";

  vfs.writeFile("/source.txt", content, label);
  vfs.cp("/source.txt", "/dest.txt");

  const result = vfs.readFileText("/dest.txt");
  assertEquals(result.value, content);
  assertEquals(result.label, label);

  // Source should still exist
  assertEquals(vfs.exists("/source.txt"), true);
});

Deno.test("VFS: mv moves files", () => {
  const vfs = new VFS();
  const label = labels.userInput();
  const content = "test content";

  vfs.writeFile("/source.txt", content, label);
  vfs.mv("/source.txt", "/dest.txt");

  // Destination should exist with same content
  const result = vfs.readFileText("/dest.txt");
  assertEquals(result.value, content);
  assertEquals(result.label, label);

  // Source should not exist
  assertEquals(vfs.exists("/source.txt"), false);
});

Deno.test("VFS: mv creates parent directories", () => {
  const vfs = new VFS();

  vfs.writeFile("/source.txt", "content", labels.bottom());
  vfs.mv("/source.txt", "/a/b/c/dest.txt");

  assertEquals(vfs.exists("/a/b/c/dest.txt"), true);
  assertEquals(vfs.exists("/source.txt"), false);
});

// ============================================================================
// Metadata Operations
// ============================================================================

Deno.test("VFS: stat returns metadata with label", () => {
  const vfs = new VFS();
  const label = labels.userInput();
  const content = "test";

  vfs.writeFile("/test.txt", content, label);
  const result = vfs.stat("/test.txt");

  assertEquals(result.label, label);
  assertEquals(result.value.size, 4); // "test" is 4 bytes
  assertEquals(result.value.mode, 0o644);
  assertEquals(typeof result.value.mtime, "number");
  assertEquals(typeof result.value.ctime, "number");
});

Deno.test("VFS: chmod changes mode", () => {
  const vfs = new VFS();

  vfs.writeFile("/test.txt", "content", labels.bottom());

  const before = vfs.stat("/test.txt");
  assertEquals(before.value.mode, 0o644);

  vfs.chmod("/test.txt", 0o755);

  const after = vfs.stat("/test.txt");
  assertEquals(after.value.mode, 0o755);
});

// ============================================================================
// Symlink Operations
// ============================================================================

Deno.test("VFS: symlink resolution works", () => {
  const vfs = new VFS();
  const content = "target content";

  vfs.writeFile("/target.txt", content, labels.bottom());
  vfs.symlink("/target.txt", "/link.txt");

  const result = vfs.readFileText("/link.txt");
  assertEquals(result.value, content);
});

Deno.test("VFS: symlink cycle detection", () => {
  const vfs = new VFS();

  vfs.symlink("/link2", "/link1");
  vfs.symlink("/link1", "/link2");

  assertThrows(
    () => vfs.readFile("/link1"),
    Error,
    "Too many levels of symbolic links",
  );
});

Deno.test("VFS: symlink to directory", () => {
  const vfs = new VFS();

  vfs.mkdir("/targetdir");
  vfs.writeFile("/targetdir/file.txt", "content", labels.bottom());
  vfs.symlink("/targetdir", "/linkdir");

  const result = vfs.readFileText("/linkdir/file.txt");
  assertEquals(result.value, "content");
});

// ============================================================================
// Path Normalization
// ============================================================================

Deno.test("VFS: path normalization handles .", () => {
  const vfs = new VFS();

  vfs.writeFile("/test.txt", "content", labels.bottom());

  const path1 = vfs.resolvePath("/./test.txt");
  const path2 = vfs.resolvePath("/././test.txt");

  assertEquals(path1, "/test.txt");
  assertEquals(path2, "/test.txt");
  assertEquals(vfs.exists(path1), true);
});

Deno.test("VFS: path normalization handles ..", () => {
  const vfs = new VFS();

  vfs.writeFile("/a/b/test.txt", "content", labels.bottom());

  const path1 = vfs.resolvePath("/a/b/../b/test.txt");
  const path2 = vfs.resolvePath("/a/b/c/../../b/test.txt");

  assertEquals(path1, "/a/b/test.txt");
  assertEquals(path2, "/a/b/test.txt");
  assertEquals(vfs.exists(path1), true);
});

Deno.test("VFS: path normalization handles double slashes", () => {
  const vfs = new VFS();

  vfs.writeFile("/test.txt", "content", labels.bottom());

  const path = vfs.resolvePath("//test.txt");

  assertEquals(path, "/test.txt");
  assertEquals(vfs.exists(path), true);
});

Deno.test("VFS: path normalization handles trailing slashes", () => {
  const vfs = new VFS();

  vfs.mkdir("/dir");

  const path1 = vfs.resolvePath("/dir/");
  const path2 = vfs.resolvePath("/dir//");

  assertEquals(path1, "/dir");
  assertEquals(path2, "/dir");
});

Deno.test("VFS: .. at root stays at root", () => {
  const vfs = new VFS();

  const path = vfs.resolvePath("/..");

  assertEquals(path, "/");
});

// ============================================================================
// Label Monotonicity
// ============================================================================

Deno.test("VFS: label monotonicity - writing lower-confidentiality succeeds", () => {
  const vfs = new VFS();

  // Write file with high confidentiality
  const highLabel = {
    confidentiality: [[{ kind: "Space" as const, id: "secret-space" }]],
    integrity: [],
  };

  vfs.writeFile("/secret.txt", "initial", highLabel);

  // Write with same label should succeed
  vfs.writeFile("/secret.txt", "updated", highLabel);

  const result = vfs.readFileText("/secret.txt");
  assertEquals(result.value, "updated");
});

Deno.test("VFS: label monotonicity - writing with missing confidentiality throws", () => {
  const vfs = new VFS();

  // Write file with confidentiality requirement
  const label1 = {
    confidentiality: [[{ kind: "Space" as const, id: "space1" }]],
    integrity: [],
  };

  vfs.writeFile("/file.txt", "initial", label1);

  // Try to write with lower confidentiality (public) - should fail
  const label2 = labels.bottom();

  assertThrows(
    () => vfs.writeFile("/file.txt", "new content", label2),
    Error,
    "Label monotonicity violation",
  );
});

Deno.test("VFS: label monotonicity - adding confidentiality succeeds", () => {
  const vfs = new VFS();

  // Write file with one confidentiality clause
  const label1 = {
    confidentiality: [[{ kind: "Space" as const, id: "space1" }]],
    integrity: [],
  };

  vfs.writeFile("/file.txt", "initial", label1);

  // Write with more restrictive label (additional clause)
  const label2 = {
    confidentiality: [
      [{ kind: "Space" as const, id: "space1" }],
      [{ kind: "Space" as const, id: "space2" }],
    ],
    integrity: [],
  };

  vfs.writeFile("/file.txt", "updated", label2);

  const result = vfs.readFileText("/file.txt");
  assertEquals(result.value, "updated");
  assertEquals(result.label, label2);
});

// ============================================================================
// Current Working Directory
// ============================================================================

Deno.test("VFS: cwd starts at root", () => {
  const vfs = new VFS();

  assertEquals(vfs.cwd, "/");
});

Deno.test("VFS: cd changes working directory", () => {
  const vfs = new VFS();

  vfs.mkdir("/home/user", true);
  vfs.cd("/home/user");

  assertEquals(vfs.cwd, "/home/user");
});

Deno.test("VFS: cd with relative path", () => {
  const vfs = new VFS();

  vfs.mkdir("/a/b/c", true);
  vfs.cd("/a");
  vfs.cd("b");

  assertEquals(vfs.cwd, "/a/b");

  vfs.cd("c");
  assertEquals(vfs.cwd, "/a/b/c");
});

Deno.test("VFS: cd with .. goes up", () => {
  const vfs = new VFS();

  vfs.mkdir("/a/b/c", true);
  vfs.cd("/a/b/c");
  vfs.cd("..");

  assertEquals(vfs.cwd, "/a/b");

  vfs.cd("../..");
  assertEquals(vfs.cwd, "/");
});

Deno.test("VFS: resolveCwd resolves relative paths", () => {
  const vfs = new VFS();

  vfs.mkdir("/home/user", true);
  vfs.cd("/home/user");

  const path1 = vfs.resolveCwd("test.txt");
  assertEquals(path1, "/home/user/test.txt");

  const path2 = vfs.resolveCwd("../other.txt");
  assertEquals(path2, "/home/other.txt");
});

Deno.test("VFS: operations work with relative paths from cwd", () => {
  const vfs = new VFS();

  vfs.mkdir("/home/user", true);
  vfs.cd("/home/user");

  vfs.writeFile("test.txt", "content", labels.bottom());

  assertEquals(vfs.exists("test.txt"), true);

  const result = vfs.readFileText("test.txt");
  assertEquals(result.value, "content");
});

// ============================================================================
// Exists
// ============================================================================

Deno.test("VFS: exists returns true for existing files", () => {
  const vfs = new VFS();

  vfs.writeFile("/test.txt", "content", labels.bottom());

  assertEquals(vfs.exists("/test.txt"), true);
});

Deno.test("VFS: exists returns true for existing directories", () => {
  const vfs = new VFS();

  vfs.mkdir("/testdir");

  assertEquals(vfs.exists("/testdir"), true);
});

Deno.test("VFS: exists returns false for nonexistent paths", () => {
  const vfs = new VFS();

  assertEquals(vfs.exists("/nonexistent"), false);
  assertEquals(vfs.exists("/a/b/c"), false);
});

// ============================================================================
// Glob Matching
// ============================================================================

Deno.test("glob: matchGlob * matches files", () => {
  assertEquals(matchGlob("*.txt", "test.txt"), true);
  assertEquals(matchGlob("*.txt", "other.txt"), true);
  assertEquals(matchGlob("*.txt", "test.md"), false);
  assertEquals(matchGlob("test*", "test.txt"), true);
  assertEquals(matchGlob("test*", "test"), true);
  assertEquals(matchGlob("*test*", "mytest.txt"), true);
});

Deno.test("glob: matchGlob ? matches single character", () => {
  assertEquals(matchGlob("test?.txt", "test1.txt"), true);
  assertEquals(matchGlob("test?.txt", "testA.txt"), true);
  assertEquals(matchGlob("test?.txt", "test12.txt"), false);
  assertEquals(matchGlob("test?.txt", "test.txt"), false);
  assertEquals(matchGlob("???", "abc"), true);
  assertEquals(matchGlob("???", "ab"), false);
});

Deno.test("glob: matchGlob [abc] matches character class", () => {
  assertEquals(matchGlob("test[123].txt", "test1.txt"), true);
  assertEquals(matchGlob("test[123].txt", "test2.txt"), true);
  assertEquals(matchGlob("test[123].txt", "test4.txt"), false);
  assertEquals(matchGlob("[abc]", "a"), true);
  assertEquals(matchGlob("[abc]", "d"), false);
});

Deno.test("glob: matchGlob [a-z] matches range", () => {
  assertEquals(matchGlob("[a-z]", "a"), true);
  assertEquals(matchGlob("[a-z]", "m"), true);
  assertEquals(matchGlob("[a-z]", "z"), true);
  assertEquals(matchGlob("[a-z]", "A"), false);
  assertEquals(matchGlob("[0-9]", "5"), true);
  assertEquals(matchGlob("[0-9]", "a"), false);
});

Deno.test("glob: expandGlob *.txt matches files in directory", () => {
  const vfs = new VFS();

  vfs.writeFile("/test1.txt", "content", labels.bottom());
  vfs.writeFile("/test2.txt", "content", labels.bottom());
  vfs.writeFile("/test.md", "content", labels.bottom());

  const result = expandGlob(vfs, "/*.txt");

  assertEquals(result.value.sort(), ["/test1.txt", "/test2.txt"].sort());
});

Deno.test("glob: expandGlob **/*.ts matches recursively", () => {
  const vfs = new VFS();

  vfs.writeFile("/a/test.ts", "content", labels.bottom());
  vfs.writeFile("/a/b/test.ts", "content", labels.bottom());
  vfs.writeFile("/a/b/c/test.ts", "content", labels.bottom());
  vfs.writeFile("/a/test.md", "content", labels.bottom());

  const result = expandGlob(vfs, "/a/**/*.ts");

  assertEquals(
    result.value.sort(),
    ["/a/test.ts", "/a/b/test.ts", "/a/b/c/test.ts"].sort(),
  );
});

Deno.test("glob: expandGlob ? pattern works", () => {
  const vfs = new VFS();

  vfs.writeFile("/test1.txt", "content", labels.bottom());
  vfs.writeFile("/test2.txt", "content", labels.bottom());
  vfs.writeFile("/test12.txt", "content", labels.bottom());

  const result = expandGlob(vfs, "/test?.txt");

  assertEquals(result.value.sort(), ["/test1.txt", "/test2.txt"].sort());
});

Deno.test("glob: expandGlob [abc] pattern works", () => {
  const vfs = new VFS();

  vfs.writeFile("/testa.txt", "content", labels.bottom());
  vfs.writeFile("/testb.txt", "content", labels.bottom());
  vfs.writeFile("/testc.txt", "content", labels.bottom());
  vfs.writeFile("/testd.txt", "content", labels.bottom());

  const result = expandGlob(vfs, "/test[abc].txt");

  assertEquals(
    result.value.sort(),
    ["/testa.txt", "/testb.txt", "/testc.txt"].sort(),
  );
});

Deno.test("glob: returned label joins all traversed directory labels", () => {
  const vfs = new VFS();

  // Create directories with different labels
  vfs.mkdir("/public");
  vfs.mkdir("/secret");

  // Write files
  vfs.writeFile("/public/test.txt", "content", labels.bottom());

  const secretLabel = {
    confidentiality: [[{ kind: "Space" as const, id: "secret" }]],
    integrity: [],
  };
  vfs.writeFile("/secret/test.txt", "content", secretLabel);

  // Get the secret directory node and update its label
  const secretDir = vfs.resolve("/secret", true);
  if (secretDir && secretDir.kind === "directory") {
    secretDir.label = secretLabel;
  }

  // Glob that traverses both directories
  const result = expandGlob(vfs, "/**/*.txt");

  // The result label should include confidentiality from secret directory
  // (join of all traversed directories)
  assertEquals(result.value.length, 2);

  // The label should have confidentiality clauses
  assertEquals(result.label.confidentiality.length > 0, true);
});

Deno.test("glob: ** matches zero directories", () => {
  const vfs = new VFS();

  vfs.writeFile("/test.ts", "content", labels.bottom());
  vfs.writeFile("/a/test.ts", "content", labels.bottom());

  const result = expandGlob(vfs, "/**/test.ts");

  assertEquals(result.value.includes("/test.ts"), true);
  assertEquals(result.value.includes("/a/test.ts"), true);
});

Deno.test("glob: expandGlob with cwd", () => {
  const vfs = new VFS();

  vfs.mkdir("/home/user", true);
  vfs.writeFile("/home/user/test1.txt", "content", labels.bottom());
  vfs.writeFile("/home/user/test2.txt", "content", labels.bottom());

  vfs.cd("/home/user");

  const result = expandGlob(vfs, "*.txt");

  assertEquals(
    result.value.sort(),
    ["/home/user/test1.txt", "/home/user/test2.txt"].sort(),
  );
});
