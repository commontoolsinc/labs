import { assert, assertEquals, assertObjectMatch } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import {
  PatternCoverageCollector,
  patternCoverageOutputPath,
  patternCoverageReportToLcov,
  Runtime,
  type RuntimeProgram,
} from "../src/index.ts";

function lineContaining(source: string, text: string): number {
  const line = source.split("\n").findIndex((entry) => entry.includes(text));
  if (line < 0) throw new Error(`Could not find source line: ${text}`);
  return line + 1;
}

function lineHits(lcov: string, sourcePath: string): Map<number, number> {
  const hits = new Map<number, number>();
  let inSource = false;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      inSource = line === `SF:${sourcePath}`;
      continue;
    }
    if (line === "end_of_record") {
      inSource = false;
      continue;
    }
    if (!inSource || !line.startsWith("DA:")) continue;
    const [lineNumber, count] = line.slice(3).split(",").map(Number);
    hits.set(lineNumber, count);
  }
  return hits;
}

function assertLineHit(
  source: string,
  lcov: string,
  sourcePath: string,
  sourceLineText: string,
): void {
  const hits = lineHits(lcov, sourcePath);
  assert((hits.get(lineContaining(source, sourceLineText)) ?? 0) > 0);
}

function assertLineMiss(
  source: string,
  lcov: string,
  sourcePath: string,
  sourceLineText: string,
): void {
  const hits = lineHits(lcov, sourcePath);
  assertEquals(hits.get(lineContaining(source, sourceLineText)), 0);
}

Deno.test("pattern coverage records original runtime lines", async () => {
  const { StorageManager } = await import("../src/storage/cache.deno.ts");
  const identity = await Identity.fromPassphrase("pattern coverage test");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "export function choose(value: number) {",
            "  const next = value + 1;",
            "  if (next > 1) {",
            "    return next;",
            "  }",
            "  return 0;",
            "}",
          ].join("\n"),
        },
      ],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(typeof main.choose, "function");
    assertEquals(main.choose(1), 2);

    const report = coverage.report();
    assertObjectMatch(report.totals, {
      coveredRuntimeLines: 4,
      uncoveredRuntimeLines: 1,
    });
    assertEquals(report.files[0].path, "/main.tsx");
    assertEquals(report.files[0].lines.coveredRuntime, [2, 3, 4, 5]);
    assertEquals(report.files[0].lines.uncoveredRuntime, [6]);

    assertEquals(
      patternCoverageReportToLcov(report),
      [
        "TN:pattern-runtime",
        "SF:/main.tsx",
        "DA:2,1",
        "DA:3,1",
        "DA:4,1",
        "DA:5,1",
        "DA:6,0",
        "LF:5",
        "LH:4",
        "end_of_record",
        "",
      ].join("\n"),
    );
    assertEquals(
      patternCoverageOutputPath(
        "/tmp/coverage",
        `${Deno.cwd()}/pattern.test.tsx`,
      ),
      "/tmp/coverage/pattern.test.tsx.pattern-coverage.lcov",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage records top-level runtime lines", async () => {
  const { StorageManager } = await import("../src/storage/cache.deno.ts");
  const identity = await Identity.fromPassphrase("top-level coverage test");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "export const first = 1;",
            "export const result = 2;",
          ].join("\n"),
        },
      ],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(main.result, 2);

    const report = coverage.report();
    assertObjectMatch(report.totals, {
      coveredRuntimeLines: 2,
      uncoveredRuntimeLines: 0,
    });
    assertEquals(report.files[0].lines.coveredRuntime, [1, 2]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage skips erased type-only namespaces", async () => {
  const { StorageManager } = await import("../src/storage/cache.deno.ts");
  const identity = await Identity.fromPassphrase(
    "type namespace coverage test",
  );
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "namespace Types {",
            "  export interface Value { value: number }",
            "}",
            "export type Result = Types.Value;",
            "export const result = 1;",
          ].join("\n"),
        },
      ],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(main.result, 1);

    const report = coverage.report();
    assertObjectMatch(report.totals, {
      coveredRuntimeLines: 1,
      uncoveredRuntimeLines: 0,
    });
    assertEquals(report.files[0].lines.coveredRuntime, [5]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage does not let outer spans cover unrun callback bodies", async () => {
  const { StorageManager } = await import("../src/storage/cache.deno.ts");
  const identity = await Identity.fromPassphrase(
    "unrun callback coverage test",
  );
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const source = [
      'import { handler } from "commonfabric";',
      "export const unused = handler(false, false, () => {",
      "  const never = 1;",
      "  return never;",
      "});",
      "export const loaded = 1;",
    ].join("\n");
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(main.loaded, 1);

    const lcov = patternCoverageReportToLcov(coverage.report());
    assertLineHit(source, lcov, "/main.tsx", "export const unused");
    assertLineMiss(source, lcov, "/main.tsx", "const never = 1;");
    assertLineMiss(source, lcov, "/main.tsx", "return never;");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage records taken and untaken control-flow branches", async () => {
  const { StorageManager } = await import("../src/storage/cache.deno.ts");
  const identity = await Identity.fromPassphrase("branch coverage test");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const source = [
      "export function choose(flag: boolean) {",
      "  let value = 0;",
      "  if (flag) {",
      "    value = 1;",
      "  } else {",
      "    value = 2;",
      "  }",
      "  return value;",
      "}",
    ].join("\n");
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(main.choose(true), 1);

    const lcov = patternCoverageReportToLcov(coverage.report());
    assertLineHit(source, lcov, "/main.tsx", "value = 1;");
    assertLineMiss(source, lcov, "/main.tsx", "value = 2;");
    assertLineHit(source, lcov, "/main.tsx", "return value;");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage treats compact control flow as line coverage", async () => {
  const { StorageManager } = await import("../src/storage/cache.deno.ts");
  const identity = await Identity.fromPassphrase(
    "compact branch coverage test",
  );
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const source = [
      "export function choose(flag: boolean) {",
      "  let value = 0;",
      "  if (flag) value = 1;",
      "  for (let i = 0; i < 2; i++) if (flag) value++;",
      "  if (flag) { value = 2;",
      "  }",
      "  return value;",
      "}",
    ].join("\n");
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(main.choose(false), 0);

    const lcov = patternCoverageReportToLcov(coverage.report());
    assertLineHit(source, lcov, "/main.tsx", "if (flag) value = 1;");
    assertLineHit(source, lcov, "/main.tsx", "for (let i = 0;");
    assertLineHit(source, lcov, "/main.tsx", "if (flag) { value = 2;");
    assertLineHit(source, lcov, "/main.tsx", "return value;");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage keeps authored lines for mixed default and named imports", async () => {
  const { StorageManager } = await import("../src/storage/cache.deno.ts");
  const identity = await Identity.fromPassphrase("mixed import coverage test");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const source = [
      'import base, { extra } from "./dep.ts";',
      "export function run() {",
      "  const value = base + extra;",
      "  return value;",
      "}",
    ].join("\n");
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        { name: "/main.tsx", contents: source },
        {
          name: "/dep.ts",
          contents: "export default 1;\nexport const extra = 2;",
        },
      ],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(main.run(), 3);

    const lcov = patternCoverageReportToLcov(coverage.report());
    assertLineHit(source, lcov, "/main.tsx", "const value = base + extra;");
    assertLineHit(source, lcov, "/main.tsx", "return value;");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage keeps authored lines when Common Fabric transform is disabled", async () => {
  const { StorageManager } = await import("../src/storage/cache.deno.ts");
  const identity = await Identity.fromPassphrase(
    "disabled transform coverage test",
  );
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const source = [
      "/// <cf-disable-transform />",
      "export function run() {",
      "  const value = 1;",
      "  return value;",
      "}",
    ].join("\n");
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    assertEquals(main.run(), 1);

    const lcov = patternCoverageReportToLcov(coverage.report());
    assertLineHit(source, lcov, "/main.tsx", "const value = 1;");
    assertLineHit(source, lcov, "/main.tsx", "return value;");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage records callback body lines after the full pipeline", async () => {
  const { StorageManager } = await import("../src/storage/cache.deno.ts");
  const identity = await Identity.fromPassphrase("callback coverage test");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const source = [
      'import { action, computed, pattern, Writable } from "commonfabric";',
      "export default pattern(() => {",
      "  const count = new Writable(0);",
      "  const inc = action(() => {",
      "    count.set(count.get() + 1);",
      "  });",
      "  const isOne = computed(() => {",
      "    const value = count.get();",
      "    return value === 1;",
      "  });",
      "  return { inc, isOne };",
      "});",
    ].join("\n");
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    };
    const coverage = new PatternCoverageCollector();
    const { main } = await runtime.harness.compileAndEvaluateModules(program, {
      patternCoverage: coverage,
    });

    assert(main);
    const resultCell = runtime.getCell(identity.did(), "callback-coverage");
    await runtime.setup(undefined, main.default, {}, resultCell);
    runtime.start(resultCell);
    await resultCell.pull();
    resultCell.key("inc").send({});
    await resultCell.pull();
    await runtime.scheduler.idle();

    const lcov = patternCoverageReportToLcov(coverage.report());
    assertLineHit(source, lcov, "/main.tsx", "const count = new Writable");
    assertLineHit(source, lcov, "/main.tsx", "count.set(count.get() + 1);");
    assertLineHit(source, lcov, "/main.tsx", "const value = count.get();");
    assertLineHit(source, lcov, "/main.tsx", "return value === 1;");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern coverage reports fabric mount paths as virtual paths", () => {
  const coverage = new PatternCoverageCollector();
  coverage.registerSpan({
    fileName: "/~cf/fid1abc/main.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });
  coverage.hit("/~cf/fid1abc/main.tsx", 1);

  const report = coverage.report({ root: "/repo" });

  assertEquals(report.files[0].path, "cf-mount/fid1abc/main.tsx");
  assertEquals(
    patternCoverageReportToLcov(report),
    [
      "TN:pattern-runtime",
      "SF:cf-mount/fid1abc/main.tsx",
      "DA:1,1",
      "LF:1",
      "LH:1",
      "end_of_record",
      "",
    ].join("\n"),
  );
});

Deno.test("pattern coverage keeps raw mount report keys before LCOV emission", () => {
  const coverage = new PatternCoverageCollector();
  coverage.registerSpan({
    fileName: "/~cf/fid1abc/main.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });
  coverage.hit("/~cf/fid1abc/main.tsx", 1);

  const report = coverage.report();

  assertEquals(report.files[0].path, "/~cf/fid1abc/main.tsx");
  assertEquals(
    patternCoverageReportToLcov(report),
    [
      "TN:pattern-runtime",
      "SF:cf-mount/fid1abc/main.tsx",
      "DA:1,1",
      "LF:1",
      "LH:1",
      "end_of_record",
      "",
    ].join("\n"),
  );
});

Deno.test("pattern coverage normalizes file URLs and relative paths", () => {
  const fileUrlCoverage = new PatternCoverageCollector();
  fileUrlCoverage.registerSpan({
    fileName: "file:///tmp/pattern.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });

  assertEquals(fileUrlCoverage.report().files[0].path, "/tmp/pattern.tsx");

  const absoluteCoverage = new PatternCoverageCollector();
  absoluteCoverage.registerSpan({
    fileName: "/absolute.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });

  assertEquals(
    absoluteCoverage.report({ root: "/repo" }).files[0].path,
    "/repo/absolute.tsx",
  );

  const relativeCoverage = new PatternCoverageCollector();
  relativeCoverage.registerSpan({
    fileName: "relative.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });

  assertEquals(
    relativeCoverage.report({ root: "/repo" }).files[0].path,
    "/repo/relative.tsx",
  );
  assertEquals(relativeCoverage.report().files[0].path, "relative.tsx");
});

Deno.test("pattern coverage ignores non-runtime spans", () => {
  const coverage = new PatternCoverageCollector();
  coverage.registerSpan({
    fileName: "/subject.tsx",
    id: 1,
    kind: "non-runtime" as "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });

  assertObjectMatch(coverage.report().files[0], {
    totals: {
      runtimeLines: 0,
      coveredRuntimeLines: 0,
      uncoveredRuntimeLines: 0,
    },
  });
});

Deno.test("pattern coverage uses the highest hit count for equal-width spans", () => {
  const coverage = new PatternCoverageCollector();
  coverage.registerSpan({
    fileName: "/subject.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });
  coverage.registerSpan({
    fileName: "/subject.tsx",
    id: 2,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });
  coverage.hit("/subject.tsx", 1);
  coverage.hit("/subject.tsx", 2);
  coverage.hit("/subject.tsx", 2);

  assertEquals(
    patternCoverageReportToLcov(coverage.report()),
    [
      "TN:pattern-runtime",
      "SF:/subject.tsx",
      "DA:1,2",
      "LF:1",
      "LH:1",
      "end_of_record",
      "",
    ].join("\n"),
  );
});

Deno.test("pattern coverage excludes test files by default", () => {
  const coverage = new PatternCoverageCollector();
  coverage.registerSpan({
    fileName: "/subject.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });
  coverage.registerSpan({
    fileName: "/subject.test.tsx",
    id: 1,
    kind: "runtime",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 10,
  });

  assertEquals(
    coverage.report().files.map((file) => file.path),
    ["/subject.tsx"],
  );
  assertEquals(
    coverage.report({ includeTestFiles: true }).files.map((file) => file.path),
    ["/subject.test.tsx", "/subject.tsx"],
  );
});

Deno.test("pattern coverage output paths distinguish separators from underscores", () => {
  const coverageDir = "/tmp/coverage";
  const cwd = Deno.cwd();
  const withSeparator = patternCoverageOutputPath(
    coverageDir,
    `${cwd}/fixtures/a/b.test.tsx`,
  );
  const withUnderscores = patternCoverageOutputPath(
    coverageDir,
    `${cwd}/fixtures/a__b.test.tsx`,
  );

  assert(withSeparator.includes("fixtures%2Fa%2Fb.test.tsx"));
  assert(withUnderscores.includes("fixtures%2Fa__b.test.tsx"));
  assert(withSeparator !== withUnderscores);
});
