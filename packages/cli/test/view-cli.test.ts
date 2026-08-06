/**
 * End-to-end coverage of the `cf view` command and its non-interactive entry
 * (mod.ts). Each case runs the real CLI as a subprocess: with stdout piped the
 * viewer prints the colourised text and exits, like `less` when redirected, so
 * these exercise the command wiring, argument handling, input reading and the
 * print path without a terminal.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { cf } from "./utils.ts";
import { MAX_BINARY_VIEW_BYTES } from "../lib/view/languages/binary/binary.ts";

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
  const { code, stdout } = await cf("view --plain", SRC);
  assertEquals(code, 0);
  assert(stdout.join("\n").includes("pattern"), stdout.join("\n"));
});

Deno.test("cf view --plain --color never prints without escapes", async () => {
  const { code, stdout } = await cf("view --plain --color never", SRC);
  assertEquals(code, 0);
  assert(!stdout.join("\n").includes("\x1b["), "no ANSI escapes");
});

Deno.test("cf view --plain --color always emits escapes", async () => {
  const { code, stdout } = await cf("view --plain --color always", SRC);
  assertEquals(code, 0);
  assert(stdout.join("\n").includes("\x1b["), "has ANSI escapes");
});

Deno.test("cf view --plain --line-numbers exits 0", async () => {
  const { code } = await cf("view --plain --line-numbers", SRC);
  assertEquals(code, 0);
});

Deno.test("cf view --plain --line-numbers prefixes lines with numbers", async () => {
  const { code, stdout } = await cf(
    "view --plain --line-numbers --color never",
    SRC,
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
  const { code, stdout } = await cf("view --plain --color never", SRC);
  assertEquals(code, 0);
  assert(
    stdout.some((line) => /^export const x = pattern/.test(line)),
    stdout.join("\n"),
  );
});

Deno.test("cf view --plain --diff renders a forced diff", async () => {
  const { code, stdout } = await cf("view --plain --diff", DIFF);
  assertEquals(code, 0);
  assert(stdout.join("\n").includes("next"), stdout.join("\n"));
});

Deno.test("cf view --plain auto-detects a diff", async () => {
  const { code, stdout } = await cf("view --plain", DIFF);
  assertEquals(code, 0);
  assert(stdout.join("\n").includes("next"));
});

Deno.test("cf view --plain --no-diff is accepted and views a diff as source", async () => {
  const { code } = await cf("view --plain --no-diff", DIFF);
  assertEquals(code, 0);
});

Deno.test("cf view --filename selects piped source by its virtual name", async () => {
  const source = "# Title with **weight**\n";
  const { code, stdout } = await cf(
    "view --plain --rendered --color never --filename notes.md",
    source,
  );
  assertEquals(code, 0);
  assertEquals(stdout, ["Title with weight"]);
});

Deno.test("cf view --language aliases override a piped virtual filename", async () => {
  const source = "# Title with **weight**\n";
  const { code, stdout } = await cf(
    "view --plain --rendered --color never --language md --filename notes.txt",
    source,
  );
  assertEquals(code, 0);
  assertEquals(stdout, ["Title with weight"]);
});

Deno.test("cf view --language binary renders piped bytes as a hex dump", async () => {
  const { code, stdout } = await cf(
    "view --plain --color never --language binary",
    new Uint8Array([0x41, 0x00, 0xff]),
  );

  assertEquals(code, 0);
  assertEquals(stdout.length, 2);
  assert(stdout[0].startsWith("00000000  41 00 ff"), stdout.join("\n"));
  assert(stdout[0].endsWith("|A␀␦|"), stdout.join("\n"));
  assertEquals(stdout[1], "00000003");
});

Deno.test("cf view detects binary content and binary virtual filenames", async () => {
  for (
    const [command, input] of [
      ["view --plain --color never", new Uint8Array([0xff])],
      [
        "view --plain --color never --filename asset.png",
        new TextEncoder().encode("PNG"),
      ],
    ] as const
  ) {
    const { code, stdout } = await cf(command, input);
    assertEquals(code, 0);
    assert(stdout[0].startsWith("00000000"), stdout.join("\n"));
  }
});

Deno.test("cf view --plain streams a complete large binary file", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const file = `${dir}/large.png`;
    Deno.writeFileSync(
      file,
      new Uint8Array(MAX_BINARY_VIEW_BYTES + 16).fill(0x41),
    );
    const { code, stdout } = await cf(
      `view --plain --color never ${file}`,
    );

    assertEquals(code, 0);
    assertEquals(stdout.length, MAX_BINARY_VIEW_BYTES / 16 + 2);
    assertEquals(stdout.at(-1), "00040010");
    assertEquals(stdout.some((line) => line.includes("omitted")), false);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cf view --plain detects and streams a large unknown binary file", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const file = `${dir}/large.data`;
    const bytes = new Uint8Array(MAX_BINARY_VIEW_BYTES + 16).fill(0x41);
    bytes[0] = 0xff;
    Deno.writeFileSync(file, bytes);
    const { code, stdout } = await cf(
      `view --plain --color never ${file}`,
    );

    assertEquals(code, 0);
    assertEquals(stdout.length, MAX_BINARY_VIEW_BYTES / 16 + 2);
    assert(stdout[0].startsWith("00000000  ff 41"), stdout[0]);
    assertEquals(stdout.at(-1), "00040010");
    assertEquals(stdout.some((line) => line.includes("omitted")), false);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cf view explicit text decoding overrides a binary virtual filename", async () => {
  const { code, stdout } = await cf(
    "view --plain --color never --language plain-text --filename asset.png",
    "PNG\n",
  );

  assertEquals(code, 0);
  assertEquals(stdout, ["PNG"]);
});

Deno.test("cf view reports bytes that the selected text decoder rejects", async () => {
  const { code, stderr } = await cf(
    "view --plain --language plain-text",
    new Uint8Array([0xff]),
  );

  assertEquals(code, 1);
  assert(
    stderr.join("\n").includes("cannot be decoded as utf-8"),
    stderr.join("\n"),
  );
});

Deno.test("cf view rejects an unknown --language", async () => {
  const { code, stderr } = await cf("view --plain --language ruby", SRC);
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
      DIFF,
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
  const { code, stderr } = await cf("view --plain --color bogus", SRC);
  assertEquals(code, 1);
  assert(stderr.join("\n").toLowerCase().includes("color"), stderr.join("\n"));
});

Deno.test("cf view reports empty piped input", async () => {
  const { code, stderr } = await cf("view --plain", "");
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

Deno.test("cf view preserves a UTF-8 BOM in redirected source output", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const path = join(dir, "bom.txt");
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a]);
    Deno.writeFileSync(path, bytes);
    const result = await new Deno.Command(Deno.execPath(), {
      cwd: join(import.meta.dirname!, ".."),
      args: [
        "task",
        "cli-no-pwd-override",
        "view",
        "--plain",
        "--color",
        "never",
        path,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0);
    assertEquals(result.stdout, bytes);
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

Deno.test("cf view accepts an empty known binary file", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const file = `${dir}/empty.png`;
    Deno.writeFileSync(file, new Uint8Array());
    const { code, stdout } = await cf(
      `view --plain --color never ${file}`,
    );
    assertEquals(code, 0);
    assertEquals(stdout, ["00000000"]);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
