import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  collectTestFiles,
  isTestFile,
  selectShardedTestFiles,
} from "./run-sharded-test-files.ts";

describe("run-sharded-test-files", () => {
  it("recognizes Deno test module names", () => {
    expect([
      "test.ts",
      "donut.test.ts",
      "donut_test.tsx",
    ].every(isTestFile)).toBe(true);
    expect(isTestFile("test-helper.ts")).toBe(false);
  });

  it("collects test modules recursively in stable order", async () => {
    const dir = await Deno.makeTempDir({ prefix: "sharded-tests-" });
    try {
      await Deno.mkdir(`${dir}/nested`);
      await Deno.writeTextFile(`${dir}/z.test.ts`, "");
      await Deno.writeTextFile(`${dir}/nested/a_test.ts`, "");
      await Deno.writeTextFile(`${dir}/nested/helper.ts`, "");

      expect(await collectTestFiles(dir)).toEqual([
        `${dir}/nested/a_test.ts`,
        `${dir}/z.test.ts`,
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("runs every file locally when no shard is selected", () => {
    expect(selectShardedTestFiles(
      ["b.test.ts", "a.test.ts"],
      undefined,
      {},
      1,
    )).toEqual(["a.test.ts", "b.test.ts"]);
  });

  it("covers every file exactly once across weighted shards", () => {
    const files = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"];
    const weights = { "a.test.ts": 10, "b.test.ts": 4 };
    const selected = [1, 2, 3].flatMap((index) =>
      selectShardedTestFiles(files, { index, total: 3 }, weights, 1)
    );

    expect(selected.sort()).toEqual(files);
  });
});
