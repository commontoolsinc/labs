import { assert, assertEquals } from "@std/assert";
import {
  classifyCacheKeyState,
  classifyRunAgainstPredecessor,
  COMPILE_CACHE_KEY_GLOBS,
  pathTouchesCompileCacheKey,
  uniformCacheStates,
} from "./perf-cache-state.ts";

Deno.test("pathTouchesCompileCacheKey matches directory-tree globs", () => {
  assert(
    pathTouchesCompileCacheKey(
      "packages/ts-transformers/src/policy/capability-analysis.ts",
    ),
  );
  assert(pathTouchesCompileCacheKey("packages/api/index.ts"));
  assert(!pathTouchesCompileCacheKey("packages/runner/src/runner.ts"));
  assert(!pathTouchesCompileCacheKey("packages/patterns/counter/main.tsx"));
});

Deno.test("pathTouchesCompileCacheKey matches exact-file entries exactly", () => {
  assert(pathTouchesCompileCacheKey("deno.lock"));
  assert(pathTouchesCompileCacheKey("deno.jsonc"));
  assert(
    pathTouchesCompileCacheKey("packages/runner/src/pattern-coverage.ts"),
  );
  // hashFiles('deno.lock') matches only the workspace-root file, and an
  // exact-file entry must not swallow name-prefixed siblings.
  assert(!pathTouchesCompileCacheKey("packages/toolshed/deno.lock"));
  assert(
    !pathTouchesCompileCacheKey("packages/runner/src/pattern-coverage.test.ts"),
  );
});

Deno.test("classifyCacheKeyState is cold iff a changed file touches the key set", () => {
  assertEquals(
    classifyCacheKeyState(["packages/runner/src/cell.ts", "docs/notes.md"]),
    "warm",
  );
  assertEquals(
    classifyCacheKeyState([
      "packages/runner/src/cell.ts",
      "packages/schema-generator/src/mod.ts",
    ]),
    "cold",
  );
  assertEquals(classifyCacheKeyState([]), "warm");
});

Deno.test("uniformCacheStates covers every compile-cache family", () => {
  const cold = uniformCacheStates("cold");
  assertEquals(Object.values(cold), Object.keys(cold).map(() => "cold"));
  assert(Object.keys(cold).includes("pattern-unit"));
  assert(Object.keys(cold).includes("pattern-integration"));
  assert(Object.keys(cold).includes("generated-patterns"));
});

Deno.test("classifyRunAgainstPredecessor classifies via changed files", async () => {
  assertEquals(
    await classifyRunAgainstPredecessor("headsha", "basesha", (base, head) => {
      assertEquals(base, "basesha");
      assertEquals(head, "headsha");
      return Promise.resolve(["deno.lock"]);
    }),
    "cold",
  );
  assertEquals(
    await classifyRunAgainstPredecessor(
      "headsha",
      "basesha",
      () => Promise.resolve(["docs/readme.md"]),
    ),
    "warm",
  );
});

Deno.test("classifyRunAgainstPredecessor fails open to unknown", async () => {
  const mustNotFetch = () => {
    throw new Error("should not fetch without a predecessor");
  };
  assertEquals(
    await classifyRunAgainstPredecessor("headsha", undefined, mustNotFetch),
    "unknown",
  );
  assertEquals(
    await classifyRunAgainstPredecessor("samesha", "samesha", mustNotFetch),
    "unknown",
  );
  assertEquals(
    await classifyRunAgainstPredecessor(
      "headsha",
      "basesha",
      () => Promise.reject(new Error("rate limited")),
    ),
    "unknown",
  );
});

// The drift guard: COMPILE_CACHE_KEY_GLOBS mirrors the FIRST hashFiles(...)
// argument list of every cc-* compile-cache key in the workflow. If this
// fails, update the constant and the workflow together (and matcherForGlob
// if a new glob shape appeared).
Deno.test("COMPILE_CACHE_KEY_GLOBS matches the cc-* cache keys in deno.yml", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/deno.yml", import.meta.url),
  );
  const keyLines = workflow.split("\n").filter((line) =>
    line.includes("cc-") && line.includes("hashFiles(")
  );
  assert(
    keyLines.length >= 3,
    `expected at least 3 cc-* cache key lines in deno.yml, found ${keyLines.length}`,
  );

  const expected = [...COMPILE_CACHE_KEY_GLOBS].sort();
  for (const line of keyLines) {
    const firstGroup = line.match(/hashFiles\(([^)]*)\)/);
    assert(firstGroup, `no hashFiles(...) group in: ${line.trim()}`);
    const globs = [...firstGroup[1].matchAll(/'([^']+)'/g)]
      .map((match) => match[1])
      .sort();
    assertEquals(
      globs,
      expected,
      `compile-cache key inputs drifted from COMPILE_CACHE_KEY_GLOBS in:\n${line.trim()}`,
    );
  }
});
