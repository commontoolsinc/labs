/**
 * End-to-end coverage of the `cf view` command and its non-interactive entry
 * (mod.ts). Each case runs the real CLI as a subprocess: with stdout piped the
 * viewer prints the colourised text and exits, like `less` when redirected, so
 * these exercise the command wiring, argument handling, input reading and the
 * print path without a terminal.
 */
import { assert, assertEquals } from "@std/assert";
import { cf } from "./utils.ts";

const SRC = "export const x = pattern(() => ({ value: 1 }));\nconst y = x;\n";
const DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
-const old = 1;
+const next = 2;
 const ctx = next;
`;

Deno.test("cf view --plain prints colourised source and exits 0", async () => {
  const { code, stdout } = await cf("view --plain", { stdin: SRC });
  assertEquals(code, 0);
  assert(stdout.join("\n").includes("pattern"), stdout.join("\n"));
});

Deno.test("cf view --plain --color never prints without escapes", async () => {
  const { code, stdout } = await cf("view --plain --color never", {
    stdin: SRC,
  });
  assertEquals(code, 0);
  assert(!stdout.join("\n").includes("\x1b["), "no ANSI escapes");
});

Deno.test("cf view --plain --color always emits escapes", async () => {
  const { code, stdout } = await cf("view --plain --color always", {
    stdin: SRC,
  });
  assertEquals(code, 0);
  assert(stdout.join("\n").includes("\x1b["), "has ANSI escapes");
});

Deno.test("cf view --plain --line-numbers exits 0", async () => {
  const { code } = await cf("view --plain --line-numbers", { stdin: SRC });
  assertEquals(code, 0);
});

Deno.test("cf view --plain --line-numbers prefixes lines with numbers", async () => {
  const { code, stdout } = await cf(
    "view --plain --line-numbers --color never",
    { stdin: SRC },
  );
  assertEquals(code, 0);
  // The two source lines are printed with a right-aligned line-number gutter.
  assert(
    stdout.some((line) => /^\s*1 export const x = pattern/.test(line)),
    stdout.join("\n"),
  );
  assert(
    stdout.some((line) => /^\s*2 const y = x;/.test(line)),
    stdout.join("\n"),
  );
});

Deno.test("cf view --plain without --line-numbers has no number gutter", async () => {
  const { code, stdout } = await cf("view --plain --color never", {
    stdin: SRC,
  });
  assertEquals(code, 0);
  assert(
    stdout.some((line) => /^export const x = pattern/.test(line)),
    stdout.join("\n"),
  );
});

Deno.test("cf view --plain --diff renders a forced diff", async () => {
  const { code, stdout } = await cf("view --plain --diff", { stdin: DIFF });
  assertEquals(code, 0);
  assert(stdout.join("\n").includes("next"), stdout.join("\n"));
});

Deno.test("cf view --plain auto-detects a diff", async () => {
  const { code, stdout } = await cf("view --plain", { stdin: DIFF });
  assertEquals(code, 0);
  assert(stdout.join("\n").includes("next"));
});

Deno.test("cf view --plain --no-diff is accepted and views a diff as source", async () => {
  const { code } = await cf("view --plain --no-diff", { stdin: DIFF });
  assertEquals(code, 0);
});

Deno.test("cf view --filename selects piped source by its virtual name", async () => {
  const source = "# Title with **weight**\n";
  const { code, stdout } = await cf(
    "view --plain --rendered --color never --filename notes.md",
    { stdin: source },
  );
  assertEquals(code, 0);
  assertEquals(stdout, ["Title with weight"]);
});

Deno.test("cf view --language aliases override a piped virtual filename", async () => {
  const source = "# Title with **weight**\n";
  const { code, stdout } = await cf(
    "view --plain --rendered --color never --language md --filename notes.txt",
    { stdin: source },
  );
  assertEquals(code, 0);
  assertEquals(stdout, ["Title with weight"]);
});

Deno.test("cf view rejects an unknown --language", async () => {
  const { code, stderr } = await cf("view --plain --language ruby", {
    stdin: SRC,
  });
  assertEquals(code, 1);
  assert(
    stderr.join("\n").includes('unknown language "ruby"'),
    stderr.join("\n"),
  );
  assert(stderr.join("\n").includes("python"), stderr.join("\n"));
});

Deno.test("cf view rejects source selection combined with forced diff mode", async () => {
  for (
    const selector of [
      "--language plain-text",
      "--filename virtual.ts",
    ]
  ) {
    const { code, stderr } = await cf(
      `view --plain --diff ${selector}`,
      { stdin: DIFF },
    );
    assertEquals(code, 1);
    assert(
      stderr.join("\n").includes(
        "--diff cannot be combined with --language or --filename",
      ),
      stderr.join("\n"),
    );
  }
});

Deno.test("cf view rejects an invalid --color", async () => {
  const { code, stderr } = await cf("view --plain --color bogus", {
    stdin: SRC,
  });
  assertEquals(code, 1);
  assert(stderr.join("\n").toLowerCase().includes("color"), stderr.join("\n"));
});

Deno.test("cf view reports empty piped input", async () => {
  const { code, stderr } = await cf("view --plain", { stdin: "" });
  assertEquals(code, 1);
  assert(
    stderr.join("\n").toLowerCase().includes("no input"),
    stderr.join("\n"),
  );
});

Deno.test("cf view reads and prints a file argument", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const file = `${dir}/transformed.ts`;
    Deno.writeTextFileSync(file, SRC);
    const { code, stdout } = await cf(`view --plain ${file}`);
    assertEquals(code, 0);
    assert(stdout.join("\n").includes("pattern"));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cf view rejects piped-input overrides with a file argument", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const file = `${dir}/source.txt`;
    Deno.writeTextFileSync(file, SRC);
    const { code, stderr } = await cf(
      `view --plain --language typescript ${file}`,
    );
    assertEquals(code, 1);
    assert(
      stderr.join("\n").includes("cannot be used with a file argument"),
      stderr.join("\n"),
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cf view --rendered formats a named Markdown file", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const file = `${dir}/notes.md`;
    Deno.writeTextFileSync(file, "# Title with **weight**\n");
    const { code, stdout } = await cf(
      `view --plain --rendered --color never ${file}`,
    );
    assertEquals(code, 0);
    assert(stdout.includes("Title with weight"), stdout.join("\n"));
    assert(!stdout.join("\n").includes("# Title"), stdout.join("\n"));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cf view reports an empty file argument", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const file = `${dir}/empty.ts`;
    Deno.writeTextFileSync(file, "   \n\n");
    const { code, stderr } = await cf(`view --plain ${file}`);
    assertEquals(code, 1);
    assert(
      stderr.join("\n").toLowerCase().includes("empty"),
      stderr.join("\n"),
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
