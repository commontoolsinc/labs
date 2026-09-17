/**
 * These pin a gate that fails CI, so it has to be exact in both directions:
 * a file the workflow stopped running has to fail, and a file it runs under
 * a line the list does not hold has to fail too.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  benchWorkflowProblems,
  main,
  namedBenchmarkFiles,
} from "./check-bench-workflow.ts";
import {
  CALIBRATION_FILE,
  KEY_BENCHMARKS,
} from "../packages/dashboard/bench-report.ts";

/** Helper for the tests below, which builds a `deno bench` list. */
const workflowRunning = (files: readonly string[]): string =>
  [
    "      - name: 🏋️ Run benchmarks",
    "        run: |",
    "          deno bench --json -A \\",
    ...files.map((file) => `            ${file} \\`),
    "            > bench-results/results.json",
    "      - name: ✅ Validate benchmark results",
    "        run: >",
    "          deno run --allow-read tasks/check-bench-report.ts",
    "          bench-results/results.json",
    "",
  ].join("\n");

const everything = (): string => workflowRunning(namedBenchmarkFiles());

const all = () => true;

/** Helper for the tests below, which runs `body` with console output captured. */
function captureConsole(body: () => void): { out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    body();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

describe("check-bench-workflow", () => {
  describe("namedBenchmarkFiles()", () => {
    it("returns the calibration file and each key benchmark's file", () => {
      expect([...namedBenchmarkFiles()]).toEqual([
        CALIBRATION_FILE,
        "packages/patterns/integration/topic-board-navigation.bench.ts",
        "packages/patterns/integration/topic-board-scale.bench.ts",
      ]);
    });

    it("returns one entry for two key benchmarks sharing a file", () => {
      // The two key benchmarks are in two files today. Nothing stops them
      // sharing one, and a file named twice would be reported twice.
      const files = namedBenchmarkFiles();
      expect(files.length).toBe(new Set(files).size);
      expect(files.length).toBeLessThanOrEqual(KEY_BENCHMARKS.length + 1);
    });
  });

  describe("benchWorkflowProblems()", () => {
    it("returns nothing for a workflow running every named file", () => {
      expect(benchWorkflowProblems(everything(), all)).toEqual([]);
    });

    it("returns the file a workflow no longer runs", () => {
      const dropped = namedBenchmarkFiles().filter((file) =>
        file !== CALIBRATION_FILE
      );
      expect(benchWorkflowProblems(workflowRunning(dropped), all)).toEqual([
        `${CALIBRATION_FILE}: named by the dashboard, not in the deno bench`,
      ]);
    });

    it("returns every file a workflow running none of them left out", () => {
      expect(benchWorkflowProblems(workflowRunning([]), all))
        .toHaveLength(namedBenchmarkFiles().length);
    });

    it("returns the file the tree no longer holds", () => {
      const [file] = namedBenchmarkFiles();
      expect(benchWorkflowProblems(everything(), (at) => at !== file)).toEqual([
        `${file}: named by the dashboard, absent from the tree`,
      ]);
    });

    it("returns the report check a workflow stopped running", () => {
      const workflow = everything().replace(
        "          deno run --allow-read tasks/check-bench-report.ts\n",
        "",
      );
      expect(benchWorkflowProblems(workflow, all)).toEqual([
        "tasks/check-bench-report.ts: no step runs it over bench-results",
      ]);
    });

    it("returns the file a workflow names outside its `deno bench` list", () => {
      // A path in a comment, or in another step, is not the list running it.
      const [file] = namedBenchmarkFiles();
      const workflow = `${everything()}\n      # see ${file} for the ruler\n`
        .replace(`\n            ${file} \\\n`, "\n");
      expect(benchWorkflowProblems(workflow, all)).toEqual([
        `${file}: named by the dashboard, not in the deno bench`,
      ]);
    });
  });

  describe("main()", () => {
    it("returns 0 and counts the files for this repository", () => {
      let code = -1;
      const { out, err } = captureConsole(() => {
        code = main();
      });
      expect(code).toBe(0);
      expect(out).toContain("names (3 files)");
      expect(err).toBe("");
    });

    it("returns 1 and names the files for a tree running none of them", () => {
      const root = Deno.makeTempDirSync({ prefix: "check-bench-workflow-" });
      Deno.mkdirSync(`${root}/.github/workflows`, { recursive: true });
      Deno.writeTextFileSync(
        `${root}/.github/workflows/benchmarks.yml`,
        workflowRunning([]),
      );
      let code = -1;
      const { out, err } = captureConsole(() => {
        code = main(`${root}/`);
      });
      Deno.removeSync(root, { recursive: true });
      expect(code).toBe(1);
      expect(out).toBe("");
      for (const file of namedBenchmarkFiles()) expect(err).toContain(file);
    });
  });
});
