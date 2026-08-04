import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { hasExecutableCode } from "./executable-source.ts";
import { parseLcov } from "./coverage-metrics.ts";

Deno.test("declarations alone compile to nothing", () => {
  const declarationOnly: [string, string][] = [
    [
      "interfaces and type aliases",
      [
        "export interface Shape {",
        "  sides: number;",
        "}",
        "export type Either = Shape | number;",
      ].join("\n"),
    ],
    [
      "ambient declarations",
      [
        "declare const external: number;",
        "export declare function helper(x: number): number;",
        "export type Reference = typeof external;",
      ].join("\n"),
    ],
    [
      "a global augmentation",
      [
        "declare global {",
        "  interface Window {",
        "    extra?: number;",
        "  }",
        "}",
        "export {};",
      ].join("\n"),
    ],
    [
      "a namespace holding only types",
      [
        "export namespace Shapes {",
        "  export interface Circle {",
        "    radius: number;",
        "  }",
        "}",
      ].join("\n"),
    ],
    [
      "a type-only re-export",
      'export type { Shape } from "./shapes.ts";',
    ],
    [
      "an import used only in type positions",
      [
        'import { Widget } from "./widget.ts";',
        "export type Rendered = (widget: Widget) => string;",
      ].join("\n"),
    ],
    [
      "comments and the module marker",
      ["/** Everything here is commented out. */", "export {};"].join("\n"),
    ],
    [
      "declarations in a file with no import or export",
      ["interface Local {", "  a: number;", "}", "type Other = Local;"].join(
        "\n",
      ),
    ],
  ];

  for (const [description, content] of declarationOnly) {
    assertEquals(hasExecutableCode(content, "example.ts"), false, description);
  }
});

Deno.test("constructs that reach the output count as executable", () => {
  const executable: [string, string][] = [
    ["a value", "export const answer = 42;"],
    ["an enum", "export enum Color {\n  Red,\n  Green,\n}"],
    ["a const enum", "export const enum Speed {\n  Slow = 1,\n}"],
    [
      "a namespace holding a value",
      "export namespace Values {\n  export const one = 1;\n}",
    ],
    [
      "an abstract class",
      "export abstract class Base {\n  abstract run(): void;\n}",
    ],
    [
      "an import kept for its side effects",
      [
        'import "./register.ts";',
        "export interface Marker {",
        "  m: true;",
        "}",
      ]
        .join("\n"),
    ],
    ["a re-export", 'export * from "./values.ts";'],
    // A file the compiler cannot parse stays charged. Error recovery emits
    // what it managed to read, so a file the gate cannot make sense of carries
    // its full charge.
    ["a file that does not parse", "export const broken = {"],
    ["text that is not code at all", "This file is prose, not TypeScript.\n"],
  ];

  for (const [description, content] of executable) {
    assertEquals(hasExecutableCode(content, "example.ts"), true, description);
  }
});

Deno.test("markup in a .tsx file is executable, its types are not", () => {
  const markup = [
    "export const Greeting = () => <div>hello</div>;",
  ].join("\n");
  const types = [
    "export interface Props {",
    "  title: string;",
    "}",
    "export type Renderer = (props: Props) => unknown;",
  ].join("\n");

  assertEquals(hasExecutableCode(markup, "component.tsx"), true);
  assertEquals(hasExecutableCode(types, "component.tsx"), false);
});

Deno.test("JavaScript is read as written", () => {
  assertEquals(hasExecutableCode("export const value = 1;\n", "mod.js"), true);
  assertEquals(hasExecutableCode("// nothing here\n", "mod.js"), false);
});

// The gate rests on a claim about Deno: a file this module calls non-executable
// has no line Deno's coverage can report as uncovered, so charging it nothing
// loses nothing. Deno transpiles with swc, and this module asks the TypeScript
// compiler, so a real coverage pass over fixture modules holds the two to the
// same answer.
Deno.test("Deno's coverage reports no uncovered line for a file that compiles to nothing", async () => {
  // Resolved, because the report names the real path and the temporary
  // directory can be reached through a symlink (macOS puts one in front of it).
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "executable-source-" }),
  );
  try {
    const fixtures: { name: string; content: string; executable: boolean }[] = [
      {
        name: "declarations.ts",
        content: [
          "export interface Shape {",
          "  sides: number;",
          "}",
          "export type Either = Shape | number;",
        ].join("\n"),
        executable: false,
      },
      {
        // An import whose binding is used only in a type position, inside a
        // global augmentation. Both compilers drop the import, so nothing of
        // this file survives to run.
        name: "augmentation.ts",
        content: [
          'import { used } from "./values.ts";',
          "declare global {",
          "  interface Window {",
          "    extra?: typeof used;",
          "  }",
          "}",
          "export {};",
        ].join("\n"),
        executable: false,
      },
      {
        name: "values.ts",
        content: [
          "export function used() {",
          "  return 1;",
          "}",
          "export function skipped() {",
          "  return 2;",
          "}",
        ].join("\n"),
        executable: true,
      },
      {
        name: "barrel.ts",
        content: 'export * from "./values.ts";\n',
        executable: true,
      },
    ];

    for (const fixture of fixtures) {
      await Deno.writeTextFile(path.join(root, fixture.name), fixture.content);
    }
    await Deno.writeTextFile(
      path.join(root, "fixture.test.ts"),
      [
        // Side-effect imports, so every fixture is loaded whether or not it
        // binds anything.
        'import "./declarations.ts";',
        'import "./augmentation.ts";',
        'import { used } from "./barrel.ts";',
        'Deno.test("drive", () => {',
        '  if (used() !== 1) throw new Error("wrong");',
        "});",
      ].join("\n"),
    );

    const rawDir = path.join(root, "raw");
    const runInFixture = (args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args,
        // Both runs read the same emit cache, which Deno keys on the config it
        // resolves; running them from the fixture directory keeps that the same
        // for the profile and the report.
        cwd: root,
        env: { DENO_COVERAGE_DIR: rawDir },
        stdout: "null",
        stderr: "piped",
      }).output();

    const generated = await runInFixture([
      "test",
      "--no-check",
      "--no-lock",
      `--coverage=${rawDir}`,
      "fixture.test.ts",
    ]);
    assert(
      generated.success,
      `generating the fixture coverage profile failed: ${
        new TextDecoder().decode(generated.stderr)
      }`,
    );

    const lcovPath = path.join(root, "fixture.lcov");
    const reported = await runInFixture([
      "coverage",
      "--lcov",
      `--output=${lcovPath}`,
      rawDir,
    ]);
    assert(
      reported.success,
      `converting the fixture profile to LCOV failed: ${
        new TextDecoder().decode(reported.stderr)
      }`,
    );

    const coverage = parseLcov(await Deno.readTextFile(lcovPath));
    const recordFor = (name: string) =>
      coverage.get(path.normalize(path.join(root, name)));

    // The run does mark lines uncovered, so the checks below mean something:
    // `skipped` is never called.
    const values = recordFor("values.ts");
    assert(values, "values.ts has no coverage record");
    assert(
      [...values.lineHits.values()].some((hits) => hits === 0),
      "values.ts reports no uncovered line",
    );

    for (const fixture of fixtures) {
      assertEquals(
        hasExecutableCode(fixture.content, path.join(root, fixture.name)),
        fixture.executable,
        fixture.name,
      );

      const record = recordFor(fixture.name);
      if (fixture.executable) {
        assert(record, `${fixture.name} has no coverage record`);
        continue;
      }
      // Either no record at all, or one whose lines the module's own load hit.
      // A comment surviving into the emitted output can leave Deno a line to
      // report, and loading the module hits it.
      const uncovered = [...record?.lineHits.values() ?? []].filter((hits) =>
        hits === 0
      );
      assertEquals(uncovered.length, 0, `${fixture.name} reports uncovered`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
