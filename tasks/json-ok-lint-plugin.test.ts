import { assert, assertEquals } from "@std/assert";
import {
  commentCarriesMarker,
  DIAGNOSTIC_CODE,
  formatBaseline,
  isSubstantiveReason,
  type JsonOkBaseline,
  loadBaseline,
  makeJsonOkPlugin,
  markerReason,
  repoRelative,
} from "./json-ok-lint-plugin.ts";

/**
 * Runs the rule over a source string and returns the one-based lines it
 * reported. `Deno.lint.runPlugin` is the real lint engine, so these tests
 * exercise the same path `deno lint` takes rather than a stand-in.
 */
function reportedLines(
  source: string,
  baseline: JsonOkBaseline = {},
  file = "packages/example/mod.ts",
): number[] {
  const plugin = makeJsonOkPlugin(baseline, { reportAll: false });
  const diagnostics = Deno.lint.runPlugin(plugin, file, source);
  return diagnostics
    .filter((d) => d.id === DIAGNOSTIC_CODE)
    .map((d) => source.slice(0, d.range[0]).split("\n").length)
    .sort((a, b) => a - b);
}

// --- markerReason: what counts as the marker ---

Deno.test("markerReason reads the reason off a line comment", () => {
  assertEquals(markerReason(" json-ok: a config file."), "a config file.");
});

Deno.test("markerReason ignores a JSDoc continuation asterisk", () => {
  assertEquals(markerReason(" * json-ok: a log line."), "a log line.");
});

Deno.test("markerReason returns null when the marker does not open the line", () => {
  assertEquals(markerReason(" this is json-ok: honest"), null);
});

Deno.test("markerReason is case-sensitive", () => {
  assertEquals(markerReason(" JSON-OK: shouting"), null);
});

Deno.test("markerReason returns empty for a bare marker", () => {
  assertEquals(markerReason(" json-ok:"), "");
});

Deno.test("isSubstantiveReason rejects an empty or wordless reason", () => {
  assert(!isSubstantiveReason(""));
  assert(!isSubstantiveReason("  "));
  assert(!isSubstantiveReason("!!!"));
  assert(isSubstantiveReason("a"));
});

Deno.test("commentCarriesMarker finds the marker on any line of a block", () => {
  assert(commentCarriesMarker("*\n * Some prose.\n * json-ok: a reason.\n "));
  assert(!commentCarriesMarker("*\n * Some prose only.\n "));
});

// --- The rule: what it flags ---

Deno.test("an unjustified call is reported", () => {
  assertEquals(reportedLines(`const a = JSON.parse("{}");\n`), [1]);
});

Deno.test("both governed members are reported", () => {
  assertEquals(
    reportedLines(
      `const a = JSON.parse("{}");\nconst b = JSON.stringify(a);\n`,
    ),
    [1, 2],
  );
});

Deno.test("a computed member reaches the same function and is reported", () => {
  assertEquals(reportedLines(`const a = JSON["parse"]("{}");\n`), [1]);
});

Deno.test("an ungoverned JSON member is left alone", () => {
  assertEquals(reportedLines(`const a = JSON.rawJSON("1");\n`), []);
});

Deno.test("a member of some other object is left alone", () => {
  assertEquals(reportedLines(`const a = notJSON.parse("{}");\n`), []);
});

Deno.test("call-shaped text inside a string is not a call", () => {
  assertEquals(reportedLines(`const a = 'JSON.parse(x)';\n`), []);
});

Deno.test("call-shaped text inside a comment is not a call", () => {
  assertEquals(
    reportedLines(`// Never write JSON.parse(x) here.\nconst a = 1;\n`),
    [],
  );
});

// --- The rule: where the marker may sit ---

Deno.test("a marker on the line above justifies the call", () => {
  assertEquals(
    reportedLines(`// json-ok: a config file.\nconst a = JSON.parse("{}");\n`),
    [],
  );
});

Deno.test("a trailing marker on the call's own line justifies it", () => {
  assertEquals(
    reportedLines(`const a = JSON.parse("{}"); // json-ok: a config file.\n`),
    [],
  );
});

Deno.test("a marker several comment lines above still justifies", () => {
  const source = `// json-ok: a config file.\n` +
    `// Some further prose about the call.\n` +
    `const a = JSON.parse("{}");\n`;
  assertEquals(reportedLines(source), []);
});

Deno.test("a marker in a block comment justifies", () => {
  const source = `/**\n * json-ok: a config file.\n */\n` +
    `const a = JSON.parse("{}");\n`;
  assertEquals(reportedLines(source), []);
});

Deno.test("a blank line between marker and call breaks the run", () => {
  const source = `// json-ok: a config file.\n\nconst a = JSON.parse("{}");\n`;
  assertEquals(reportedLines(source), [3]);
});

Deno.test("a bare marker with no reason does not justify", () => {
  assertEquals(
    reportedLines(`// json-ok:\nconst a = JSON.parse("{}");\n`),
    [2],
  );
});

Deno.test("a marker above the statement covers a call nested inside it", () => {
  const source = `// json-ok: a config file.\n` +
    `const a = wrap(\n  JSON.parse("{}"),\n);\n`;
  assertEquals(reportedLines(source), []);
});

Deno.test("a marker directly above a deeply nested call justifies it", () => {
  const source = `const a = [\n` +
    `  "x",\n` +
    `  // json-ok: quoting a constant into generated source.\n` +
    `  JSON.stringify(field),\n` +
    `];\n`;
  assertEquals(reportedLines(source), []);
});

Deno.test("a previous statement's trailing marker does not reach forward", () => {
  const source = `const a = 1; // json-ok: not about the next line.\n` +
    `const b = JSON.parse("{}");\n`;
  assertEquals(reportedLines(source), [2]);
});

Deno.test("a marker justifies only the statement it sits above", () => {
  const source = `// json-ok: a config file.\n` +
    `const a = JSON.parse("{}");\n` +
    `const b = JSON.parse("[]");\n`;
  assertEquals(reportedLines(source), [3]);
});

// --- The rule: the per-file budget ---

Deno.test("a file within its budget reports nothing", () => {
  const source = `const a = JSON.parse("{}");\nconst b = JSON.stringify(a);\n`;
  assertEquals(reportedLines(source, { "packages/example/mod.ts": 2 }), []);
});

Deno.test("a file over its budget reports every unjustified call", () => {
  const source = `const a = JSON.parse("{}");\n` +
    `const b = JSON.stringify(a);\n` +
    `const c = JSON.parse("[]");\n`;
  assertEquals(reportedLines(source, { "packages/example/mod.ts": 2 }), [
    1,
    2,
    3,
  ]);
});

Deno.test("a budget names itself in the diagnostic", () => {
  const plugin = makeJsonOkPlugin({ "packages/example/mod.ts": 1 }, {
    reportAll: false,
  });
  const source = `const a = JSON.parse("{}");\nconst b = JSON.parse("[]");\n`;
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "packages/example/mod.ts",
    source,
  );
  assertEquals(diagnostics.length, 2);
  assert(diagnostics[0].message.includes("budget is 1"));
  assert(diagnostics[0].message.includes("now holds 2"));
});

Deno.test("a budget does not excuse a file it does not name", () => {
  const source = `const a = JSON.parse("{}");\n`;
  assertEquals(reportedLines(source, { "packages/other/mod.ts": 9 }), [1]);
});

Deno.test("justified calls do not consume the budget", () => {
  const source = `// json-ok: a config file.\n` +
    `const a = JSON.parse("{}");\n` +
    `const b = JSON.parse("[]");\n`;
  assertEquals(reportedLines(source, { "packages/example/mod.ts": 1 }), []);
});

Deno.test("reportAll ignores the budget entirely", () => {
  const plugin = makeJsonOkPlugin({ "packages/example/mod.ts": 5 }, {
    reportAll: true,
  });
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "packages/example/mod.ts",
    `const a = JSON.parse("{}");\n`,
  );
  assertEquals(diagnostics.length, 1);
});

// --- Baseline plumbing ---

Deno.test("repoRelative reduces an absolute path to a repo-relative one", () => {
  assertEquals(
    repoRelative("/repo/packages/x/mod.ts", "/repo"),
    "packages/x/mod.ts",
  );
});

Deno.test("repoRelative leaves an already-relative path alone", () => {
  assertEquals(repoRelative("packages/x/mod.ts", "/repo"), "packages/x/mod.ts");
});

Deno.test("formatBaseline sorts keys and drops zeroes", () => {
  assertEquals(
    formatBaseline({ "b.ts": 1, "a.ts": 2, "c.ts": 0 }),
    '{\n  "a.ts": 2,\n  "b.ts": 1\n}\n',
  );
});

Deno.test("loadBaseline reads a missing file as empty", () => {
  assertEquals(loadBaseline("/nonexistent/json-ok-baseline.json"), {});
});

Deno.test("the checked-in baseline round-trips through its own formatter", () => {
  const baseline = loadBaseline();
  assertEquals(
    formatBaseline(baseline),
    Deno.readTextFileSync(
      new URL("./json-ok-baseline.json", import.meta.url),
    ),
    "The baseline file is not in canonical form; run `deno task check-json-ok --update`.",
  );
});
