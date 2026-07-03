/// <reference lib="deno.unstable" />

import { assertEquals } from "@std/assert";

import { createNoAsAnyRule } from "../lint-plugins/no-as-any.ts";

const MESSAGE =
  "Type assertions to `any` hide type errors. Use a narrower type, a type guard, or a typed helper.";

const repoRoot = decodeURIComponent(new URL("../", import.meta.url).pathname)
  .replace(/\/$/, "");

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
