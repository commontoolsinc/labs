import { assertEquals } from "@std/assert";
import { buildDenoTestArgs, selectUtilsTestFiles } from "./run-tests.ts";

Deno.test("selectUtilsTestFiles keeps bigint tests on the second two-way shard", () => {
  const files = [
    "test/arrays.test.ts",
    "test/base64url.test.ts",
    "test/bigint.test.ts",
    "test/cache.test.ts",
    "test/logger.test.ts",
    "test/sleep.test.ts",
  ];

  assertEquals(selectUtilsTestFiles(files, { index: 1, total: 2 }), [
    "test/arrays.test.ts",
    "test/cache.test.ts",
    "test/sleep.test.ts",
  ]);
  assertEquals(selectUtilsTestFiles(files, { index: 2, total: 2 }), [
    "test/base64url.test.ts",
    "test/bigint.test.ts",
    "test/logger.test.ts",
  ]);
});

Deno.test("selectUtilsTestFiles returns every file without a shard", () => {
  const files = ["test/a.test.ts", "test/b.test.ts"];
  assertEquals(selectUtilsTestFiles(files, undefined), files);
});

Deno.test("buildDenoTestArgs forwards task arguments before selected files", () => {
  assertEquals(
    buildDenoTestArgs(["test/logger.test.ts"], ["--", "--filter", "logger"]),
    ["test", "--no-check", "--filter", "logger", "test/logger.test.ts"],
  );
});
