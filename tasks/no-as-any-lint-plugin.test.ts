/// <reference lib="deno.unstable" />

import { assertEquals } from "@std/assert";
import { walk } from "@std/fs/walk";

import { createNoAsAnyRule } from "../lint-plugins/no-as-any.ts";

const MESSAGE =
  "Type assertions to `any` hide type errors. Use a narrower type, a type guard, or a typed helper.";

const repoRoot = decodeURIComponent(new URL("../", import.meta.url).pathname)
  .replace(/\/$/, "");
const sourceScanSkipPrefixes = [
  ".agents/",
  ".beads/",
  ".cache/",
  ".claude/",
  ".git/",
  "build/",
  "coverage/",
  "dist/",
  "node_modules/",
  "packages/patterns/record/",
  "packages/static/assets/",
  "packages/vendor-astral/",
  "tmp/",
  "tutorials/",
];
const sourceScanSkipPatterns = sourceScanSkipPrefixes.map((prefix) =>
  new RegExp(
    `^${escapeRegExp(repoRoot)}[/\\\\]${
      escapeRegExp(prefix).replaceAll("/", "[/\\\\]")
    }`,
  )
);

function pluginWithAllowlist(
  allowlistEntries: Parameters<typeof createNoAsAnyRule>[0] = [],
): Deno.lint.Plugin {
  return {
    name: "cf-no-as-any-test",
    rules: {
      "no-as-any": createNoAsAnyRule(allowlistEntries),
    },
  };
}

function pluginWithRepositoryAllowlist(): Deno.lint.Plugin {
  return {
    name: "cf-no-as-any-test",
    rules: {
      "no-as-any": createNoAsAnyRule(),
    },
  };
}

function runLint(
  source: string,
  allowlistEntries: Parameters<typeof createNoAsAnyRule>[0] = [],
) {
  return Deno.lint.runPlugin(
    pluginWithAllowlist(allowlistEntries),
    `${repoRoot}/src/example.ts`,
    source,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldScanSourcePath(path: string): boolean {
  return !sourceScanSkipPrefixes.some((prefix) => path.startsWith(prefix));
}

Deno.test("no-as-any lint plugin reports casts whose asserted type is any", () => {
  const diagnostics = runLint("const value = input as any;\n");

  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]!.message, MESSAGE);
});

Deno.test("no-as-any lint plugin reports casts whose asserted type contains any", () => {
  assertEquals(runLint("const value = input as any[];\n").length, 1);
  assertEquals(runLint("const value = input as Array<any>;\n").length, 1);
  assertEquals(runLint("const value = input as { any: any };\n").length, 1);
});

Deno.test("no-as-any lint plugin reports angle-bracket casts to any", () => {
  const diagnostics = runLint("const value = <any>input;\n");

  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]!.message, MESSAGE);
});

Deno.test("no-as-any lint plugin ignores casts to types without any", () => {
  assertEquals(runLint("const value = input as Widget;\n"), []);
  assertEquals(runLint('const value = input as "any";\n'), []);
  assertEquals(runLint("const value = input as Many;\n"), []);
});

Deno.test("no-as-any lint plugin ignores names that are not any types", () => {
  assertEquals(runLint("const value = input as { any: string };\n"), []);
  assertEquals(runLint("const value = input as { any?: string };\n"), []);
  assertEquals(runLint("const value = input as { any(): string };\n"), []);
  assertEquals(runLint("const value = input as { any?(): string };\n"), []);
  assertEquals(runLint("const value = input as { get any(): string };\n"), []);
  assertEquals(
    runLint("const value = input as { [any: string]: string };\n"),
    [],
  );
  assertEquals(runLint("const value = input as (any: string) => void;\n"), []);
});

Deno.test("no-as-any lint plugin skips allowlisted files", () => {
  const diagnostics = runLint(
    "const value = input as any;\n",
    ["src/example.ts"],
  );

  assertEquals(diagnostics, []);
});

Deno.test("no-as-any lint plugin reports files outside the allowlist", () => {
  const diagnostics = runLint(
    "const value = other as any;\n",
    ["src/other.ts"],
  );

  assertEquals(diagnostics.length, 1);
});

Deno.test("no-as-any lint plugin reports repository files outside the allowlist", async () => {
  const plugin = pluginWithRepositoryAllowlist();
  const diagnostics: string[] = [];

  for await (
    const entry of walk(repoRoot, {
      includeDirs: false,
      exts: [".ts", ".tsx"],
      skip: sourceScanSkipPatterns,
    })
  ) {
    const relativePath = entry.path.slice(repoRoot.length + 1)
      .replaceAll("\\", "/");
    if (!shouldScanSourcePath(relativePath)) continue;

    const source = await Deno.readTextFile(entry.path);
    for (const diagnostic of Deno.lint.runPlugin(plugin, entry.path, source)) {
      diagnostics.push(`${relativePath}: ${diagnostic.message}`);
    }
  }

  assertEquals(diagnostics, []);
});
