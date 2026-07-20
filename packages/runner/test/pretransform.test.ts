import {
  assertEquals,
  assertMatch,
  assertNotMatch,
  assertThrows,
} from "@std/assert";
import {
  preserveLineCount,
  transformInjectHelperModule,
} from "../src/harness/pretransform.ts";
import { helperInjectionLineOffset } from "../src/harness/engine.ts";
import { injectCfHelpers } from "@commonfabric/ts-transformers";
import type { RuntimeProgram } from "../src/harness/types.ts";

import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";

// These tests drive the sync parse internals directly (below the async flow
// boundaries that normally load the deferred compiler stack), so load it here.
await ensureCompilerStack();

Deno.test("transformInjectHelperModule transforms by default and respects cf-disable-transform", () => {
  const program: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents: [
          'import { pattern } from "commonfabric";',
          "export default pattern<{ value: string }>(({ value }) => ({ value }));",
        ].join("\n"),
      },
      {
        name: "/plain.tsx",
        contents: [
          "/// <cf-disable-transform />",
          "export const value = 1;",
        ].join("\n"),
      },
    ],
  };

  const transformed = transformInjectHelperModule(program);
  const main = transformed.files.find((file) => file.name === "/main.tsx")!;
  const plain = transformed.files.find((file) => file.name === "/plain.tsx")!;

  assertMatch(
    main.contents,
    /import \{ __cfHelpers \} from "commonfabric";/,
  );
  assertNotMatch(main.contents, /cts-enable/);

  assertNotMatch(
    plain.contents,
    /import \{ __cfHelpers \} from "commonfabric";/,
  );
  assertNotMatch(plain.contents, /cf-disable-transform/);
});

Deno.test("transformInjectHelperModule warns only on an indented (ignored) cf-disable-transform", () => {
  const run = (name: string, contents: string) => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const out = transformInjectHelperModule({
        main: name,
        files: [{ name, contents }],
      });
      return { warnings, contents: out.files[0]!.contents };
    } finally {
      console.warn = originalWarn;
    }
  };

  // Indented directive: not honored, so the file is transformed as usual —
  // and the author is warned, by file name, that it was ignored.
  const indented = run(
    "/indented.tsx",
    ["  /// <cf-disable-transform />", "export const value = 1;"].join("\n"),
  );
  assertMatch(
    indented.contents,
    /import \{ __cfHelpers \} from "commonfabric";/,
  );
  assertEquals(indented.warnings.length, 1);
  assertMatch(indented.warnings[0]!, /\/indented\.tsx/);
  assertMatch(indented.warnings[0]!, /column zero/);

  // Column-zero directive: honored (transform disabled) and no warning.
  const columnZero = run(
    "/plain.tsx",
    ["/// <cf-disable-transform />", "export const value = 1;"].join("\n"),
  );
  assertNotMatch(
    columnZero.contents,
    /import \{ __cfHelpers \} from "commonfabric";/,
  );
  assertEquals(columnZero.warnings.length, 0);
});

Deno.test("transformInjectHelperModule passes .d.ts files through untouched", () => {
  const declarations = "export declare const value: number;\n";
  const transformed = transformInjectHelperModule({
    main: "/main.tsx",
    files: [
      { name: "/main.tsx", contents: "export default 1;" },
      { name: "/types.d.ts", contents: declarations },
    ],
  });

  const main = transformed.files.find((file) => file.name === "/main.tsx")!;
  const types = transformed.files.find((file) => file.name === "/types.d.ts")!;

  // A declaration file is types-only, so it bypasses the transform entirely:
  // injecting the `__cfHelpers` value import would be invalid in a .d.ts. It is
  // passed through byte-identical, while an ordinary source still gets helpers.
  assertMatch(main.contents, /import \{ __cfHelpers \} from "commonfabric";/);
  assertEquals(types.contents, declarations);
  assertNotMatch(types.contents, /__cfHelpers/);
});

Deno.test("transformInjectHelperModule injects JS-syntax helpers into .js sources", () => {
  const program: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents: "export default 42;",
      },
      {
        name: "/helper.js",
        contents: "export const add = (x, y) => x + y;",
      },
    ],
  };

  const transformed = transformInjectHelperModule(program);
  const main = transformed.files.find((file) => file.name === "/main.tsx")!;
  const helper = transformed.files.find((file) => file.name === "/helper.js")!;

  // Both get the helper import...
  assertMatch(main.contents, /import \{ __cfHelpers \} from "commonfabric";/);
  assertMatch(
    helper.contents,
    /import \{ __cfHelpers \} from "commonfabric";/,
  );
  // ...but the `h` shim in the .js file must not carry a TS type annotation
  // ("Type annotations can only be used in TypeScript files").
  assertMatch(main.contents, /function h\(\.\.\.args: any\[\]\)/);
  assertMatch(helper.contents, /function h\(\.\.\.args\)/);
  assertNotMatch(helper.contents, /any\[\]/);
});

// Coverage remapping assumes this pretransform only adds the one-line helper
// prelude. Mixed import splitting must preserve the original line count.
Deno.test("mixed import rewrite must not drift coverage line numbers", () => {
  const transformedContents = (contents: string): string =>
    transformInjectHelperModule({
      main: "/m.tsx",
      files: [{ name: "/m.tsx", contents }],
    }).files[0]!.contents;
  const markerOutputLine = (contents: string): number =>
    transformedContents(contents).split("\n").findIndex((line) =>
      line.includes("MARKER")
    ) + 1;

  // Control: single-line attributes preserve the count. MARKER is authored line
  // 2, so after the one-line helper prepend it lands on output line 3.
  const singleLineAttributes =
    `import D, { a } from "x" with { type: "json" };\nconst MARKER = 1;\n`;
  assertEquals(markerOutputLine(singleLineAttributes), 3);

  // MARKER is authored line 4, so after the one-line helper prepend it must land
  // on output line 5. The rewrite must not add lines for multi-line attributes.
  const multiLineAttributes =
    `import D, { a } from "x" with {\n  type: "json"\n};\nconst MARKER = 1;\n`;
  assertEquals(markerOutputLine(multiLineAttributes), 5);

  // Multi-line named bindings must not drift either. MARKER is authored line 5,
  // so after the helper prepend it lands on output line 6.
  const multiLineNamedBindings =
    `import D, {\n  a,\n  b,\n} from "x";\nconst MARKER = 1;\n`;
  assertEquals(markerOutputLine(multiLineNamedBindings), 6);

  const defaultInNamedBindings =
    `import { default as D, a } from "x";\nconst MARKER = 1;\n`;
  assertEquals(markerOutputLine(defaultInNamedBindings), 3);
  assertMatch(
    transformedContents(defaultInNamedBindings),
    /import D from "x"; import \{ a \} from "x";/,
  );

  const onlyDefaultInNamedBindings =
    `import { default as D } from "x";\nconst MARKER = 1;\n`;
  assertEquals(markerOutputLine(onlyDefaultInNamedBindings), 3);
  assertMatch(
    transformedContents(onlyDefaultInNamedBindings),
    /import D from "x";\nconst MARKER/,
  );

  const nonStringImportAttribute =
    `import { default as D, a } from "x" with { type: json };\nconst MARKER = 1;\n`;
  assertEquals(markerOutputLine(nonStringImportAttribute), 3);
  assertMatch(
    transformedContents(nonStringImportAttribute),
    /with \{ type: json \}; import \{ a \} from "x" with \{ type: json \};/,
  );
});

Deno.test("preserveLineCount rejects expanding rewrites", () => {
  assertEquals(preserveLineCount("one\ntwo", "one"), "one\n");
  assertThrows(
    () => preserveLineCount("one", "one\ntwo"),
    Error,
    "Import rewrite expanded from 1 to 2 lines",
  );
});

// The coverage span mapper subtracts `helperInjectionLineOffset` from every span
// line to recover the authored line, so it has to predict exactly how far
// `transformInjectHelperModule` moved that file's content. The two live in
// different modules and the prediction is a re-implementation of the injector's
// branches, so pin them against each other rather than against a hand-written
// number: only the leading helper import shifts lines, and the trailing `h` shim
// the injector also appends must not count.
Deno.test("helperInjectionLineOffset matches what the injector actually shifts", async () => {
  await ensureCompilerStack();
  const MARKER = "const marker = 1;";

  // Every shape that reaches the mapper, and what the injector does with it.
  const cases: { label: string; source: string }[] = [
    { label: "plain authored source", source: `const top = 0;\n${MARKER}\n` },
    {
      label: "disable-transform directive (blanked in place)",
      source: `/// <cf-disable-transform />\nconst top = 0;\n${MARKER}\n`,
    },
    {
      label: "stored legacy envelope (passes through untouched)",
      source: injectCfHelpers(`const top = 0;\n${MARKER}\n`),
    },
  ];

  for (const { label, source } of cases) {
    const injected = transformInjectHelperModule(
      { main: "/main.tsx", files: [{ name: "/main.tsx", contents: source }] },
      // Mounts and the stored-source recompile both tolerate the legacy
      // envelope; this is the path whose offsets the mapper has to predict.
      { tolerateStoredLegacyEnvelope: true },
    ).files[0].contents;

    const lineOf = (text: string, needle: string) =>
      text.split("\n").findIndex((line) => line.includes(needle)) + 1;
    const authoredLine = lineOf(source, MARKER);
    const injectedLine = lineOf(injected, MARKER);
    assertEquals(authoredLine > 0 && injectedLine > 0, true, label);

    // A span is measured over the injected text; adding the offset must land on
    // the authored line.
    assertEquals(
      injectedLine + helperInjectionLineOffset(source),
      authoredLine,
      `${label}: offset does not recover the authored line`,
    );
  }
});

Deno.test("helperInjectionLineOffset leaves a blank file alone", async () => {
  await ensureCompilerStack();
  // "Content" here means any non-blank line, comments included — a
  // comment-only file is injected like any other, so only a wholly blank file
  // takes this branch. Assert against what the injector did rather than a bare
  // number, so the two cannot drift apart.
  for (const source of ["", "\n\n"]) {
    const injected = transformInjectHelperModule(
      { main: "/main.tsx", files: [{ name: "/main.tsx", contents: source }] },
      { tolerateStoredLegacyEnvelope: true },
    ).files[0].contents;
    assertEquals(injected, source, "the injector touched a blank file");
    assertEquals(helperInjectionLineOffset(source), 0);
  }
});
