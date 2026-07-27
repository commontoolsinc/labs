import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  collectCoverageProfileFiles,
  normalizeLcovInstancePaths,
} from "./write-coverage-lcov.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const SCRIPT = join(REPO_ROOT, "tasks/write-coverage-lcov.ts");

Deno.test("normalizeLcovInstancePaths strips a per-instance query from SF lines", () => {
  assertEquals(
    normalizeLcovInstancePaths(
      "SF:/a/b/foo.ts?testRun=abc-123\nDA:1,1\nend_of_record",
    ),
    "SF:/a/b/foo.ts\nDA:1,1\nend_of_record",
  );
});

Deno.test("normalizeLcovInstancePaths leaves a plain path and non-SF lines unchanged", () => {
  const input = "SF:/a/b/foo.ts\nDA:1,1\nFN:2,x\nend_of_record";
  assertEquals(normalizeLcovInstancePaths(input), input);
});

// Two cache-busting imports of one file arrive as two records; collapsing the
// suffix is what lets a downstream consumer accumulate them as one file.
Deno.test("normalizeLcovInstancePaths maps two instances of one file to the same path", () => {
  const out = normalizeLcovInstancePaths(
    [
      "SF:/a/foo.ts?testRun=1",
      "DA:1,1",
      "end_of_record",
      "SF:/a/foo.ts?testRun=2",
      "DA:1,0",
      "end_of_record",
    ].join("\n"),
  );
  assertEquals(
    out.split("\n").filter((line) => line.startsWith("SF:")),
    ["SF:/a/foo.ts", "SF:/a/foo.ts"],
  );
});

Deno.test("normalizeLcovInstancePaths handles CRLF input", () => {
  assertEquals(
    normalizeLcovInstancePaths(
      "SF:/a/foo.ts?testRun=1\r\nDA:1,1\r\nend_of_record",
    ),
    "SF:/a/foo.ts\nDA:1,1\nend_of_record",
  );
});

// Runs the script as `deno task` does, through the lockfile-isolating helper.
async function runScript(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    args: (lockPath) => [
      "run",
      "--config",
      join(REPO_ROOT, "deno.jsonc"),
      "--lock",
      lockPath,
      "--allow-read",
      "--allow-write",
      "--allow-run",
      SCRIPT,
      ...args,
    ],
  });
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

Deno.test("write-coverage-lcov prints usage and exits 2 without arguments", async () => {
  const result = await runScript([]);
  assertEquals(result.code, 2);
  assertStringIncludes(result.stderr, "Usage:");
});

Deno.test("write-coverage-lcov writes an empty report when the profile dir is absent", async () => {
  const root = await Deno.makeTempDir({ prefix: "write-lcov-" });
  try {
    const output = join(root, "out.lcov");
    const result = await runScript([join(root, "missing"), output]);
    assertEquals(result.code, 0);
    assertEquals(await Deno.readTextFile(output), "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// An empty profile file is dropped, and with nothing left the script writes an
// empty report rather than invoking `deno coverage` on it.
Deno.test("write-coverage-lcov drops empty profiles and reports none remain", async () => {
  const root = await Deno.makeTempDir({ prefix: "write-lcov-" });
  try {
    const profileDir = join(root, "raw");
    await Deno.mkdir(profileDir);
    await Deno.writeTextFile(join(profileDir, "empty.json"), "");
    const output = join(root, "out.lcov");

    const result = await runScript([profileDir, output]);

    assertEquals(result.code, 0);
    assertEquals(await Deno.readTextFile(output), "");
    assertEquals([...Deno.readDirSync(profileDir)].length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// The happy path: a real V8 coverage profile is generated from a standalone
// test, then converted to an LCOV report with the instance-path suffix stripped.
Deno.test("write-coverage-lcov converts real profiles to a normalized LCOV report", async () => {
  const root = await Deno.makeTempDir({ prefix: "write-lcov-" });
  try {
    await Deno.writeTextFile(
      join(root, "sample.ts"),
      "export const add = (a: number, b: number): number => a + b;\n",
    );
    await Deno.writeTextFile(
      join(root, "sample.test.ts"),
      'import { add } from "./sample.ts";\n' +
        'Deno.test("add", () => {\n' +
        '  if (add(1, 2) !== 3) throw new Error("wrong");\n' +
        "});\n",
    );
    const rawDir = join(root, "raw");
    const generate = await new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "--no-check",
        "--no-lock",
        `--coverage=${rawDir}`,
        join(root, "sample.test.ts"),
      ],
      env: { DENO_COVERAGE_DIR: rawDir },
      stdout: "null",
      stderr: "null",
    }).output();
    assert(generate.success, "generating the sample coverage profile failed");

    const output = join(root, "out.lcov");
    const result = await runScript([rawDir, output]);

    assertEquals(result.code, 0);
    const lcov = await Deno.readTextFile(output);
    assertStringIncludes(lcov, "SF:");
    assertStringIncludes(lcov, "sample.ts");
    // The suffix stripper ran over the report, so no instance query survives.
    assert(
      !lcov.includes("?testRun="),
      "instance query survived normalization",
    );
    assertStringIncludes(result.stdout, "Wrote LCOV");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

function dirEntry(name: string, isDirectory: boolean): Deno.DirEntry {
  return { name, isDirectory, isFile: !isDirectory, isSymlink: false };
}

// A full coverage run can leave far more profile files in one directory than
// the number of arguments V8 lets a single call take (a ceiling near 130,000).
// Present the collector a directory that large through an injected reader — no
// real files — and confirm it gathers every profile. A collector that merged a
// subdirectory's list into its parent with a spread would overflow here; a
// walk that appends into one shared array does not, whatever the stack size.
Deno.test("collectCoverageProfileFiles gathers a directory larger than the argument limit", async () => {
  const COUNT = 200_000;
  const root = "/coverage-root";
  const sub = join(root, "sub");
  const readDir = (dir: string): AsyncIterable<Deno.DirEntry> => {
    async function* entries(): AsyncGenerator<Deno.DirEntry> {
      if (dir === root) {
        yield dirEntry("sub", true);
      } else if (dir === sub) {
        for (let i = 0; i < COUNT; i++) yield dirEntry(`p${i}.json`, false);
      }
    }
    return entries();
  };

  const files = await collectCoverageProfileFiles(root, readDir);

  assertEquals(files.length, COUNT);
  assertEquals(files[0], join(sub, "p0.json"));
  assertEquals(files.at(-1), join(sub, `p${COUNT - 1}.json`));
});

Deno.test("collectCoverageProfileFiles walks nested directories and keeps only .json", async () => {
  const root = await Deno.makeTempDir({ prefix: "write-lcov-collect-" });
  try {
    await Deno.writeTextFile(join(root, "top.json"), "{}");
    await Deno.writeTextFile(join(root, "ignored.txt"), "");
    const nested = join(root, "nested", "deeper");
    await Deno.mkdir(nested, { recursive: true });
    await Deno.writeTextFile(join(nested, "leaf.json"), "{}");
    await Deno.writeTextFile(join(nested, "notes.md"), "");

    const files = await collectCoverageProfileFiles(root);

    assertEquals(files.sort(), [
      join(root, "nested", "deeper", "leaf.json"),
      join(root, "top.json"),
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("collectCoverageProfileFiles returns empty for a missing directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "write-lcov-collect-" });
  try {
    assertEquals(await collectCoverageProfileFiles(join(root, "missing")), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
