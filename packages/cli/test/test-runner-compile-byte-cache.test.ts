import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join, resolve } from "@std/path";
import type { CompiledModuleArtifact } from "@commonfabric/runner";
import {
  ProcessModuleByteCache,
  restoreCompileByteCacheForTesting,
  writeCompileByteCacheForTesting,
} from "@commonfabric/test-support/compile-byte-cache";
import { runTests } from "../lib/test-runner.ts";
import { cf, checkStderr, withEnv } from "./utils.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/pattern-coverage");
const TEST_FILE = join(FIXTURES, "single.test.tsx").replaceAll("\\", "/");

class CountingProcessModuleByteCache extends ProcessModuleByteCache {
  fullHits = 0;

  override getCompleteSet(
    runtimeVersion: string,
    identities: readonly string[],
  ): Map<string, CompiledModuleArtifact> | undefined {
    const result = super.getCompleteSet(runtimeVersion, identities);
    if (result !== undefined) {
      this.fullHits++;
    }
    return result;
  }
}

async function readCoverageText(coverageDir: string): Promise<string> {
  const chunks: string[] = [];
  async function readDirectory(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        await readDirectory(path);
      } else if (entry.isFile && entry.name.endsWith(".lcov")) {
        chunks.push(await Deno.readTextFile(path));
      }
    }
  }
  await readDirectory(coverageDir);
  return chunks.join("\n");
}

describe(
  "cf test compile byte cache",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("restores compiled modules from disk for a later compile", async () => {
      const dir = await Deno.makeTempDir({
        prefix: "cf-test-compile-byte-cache-",
      });
      const cacheFile = join(dir, "cache.json");

      try {
        const firstCache = new ProcessModuleByteCache();
        const first = await runTests(TEST_FILE, {
          root: FIXTURES,
          moduleByteCache: firstCache,
        });

        expect(first.failed).toBe(0);
        expect(first.passed).toBeGreaterThan(0);
        expect(firstCache.stats().entries).toBeGreaterThan(0);
        expect(writeCompileByteCacheForTesting(firstCache, cacheFile))
          .toBeGreaterThan(0);

        const restoredCache = new CountingProcessModuleByteCache();
        expect(restoreCompileByteCacheForTesting(restoredCache, cacheFile))
          .toBeGreaterThan(0);

        const second = await runTests(TEST_FILE, {
          root: FIXTURES,
          moduleByteCache: restoredCache,
        });

        expect(second.failed).toBe(0);
        expect(second.passed).toBe(first.passed);
        expect(restoredCache.fullHits).toBeGreaterThan(0);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("uses CF_COMPILE_CACHE_FILE across cf test processes", async () => {
      const dir = await Deno.makeTempDir({
        prefix: "cf-test-compile-byte-cache-env-",
      });
      const cacheFile = join(dir, "cache.json");
      const command = `test "${TEST_FILE}" --root "${FIXTURES}"`;

      try {
        await withEnv("CF_COMPILE_CACHE_FILE", cacheFile, async () => {
          await withEnv("CF_LOG_LEVEL", "info", async () => {
            const first = await cf(command);
            expect(first.code).toBe(0);
            checkStderr(first.stderr);
            const entries = JSON.parse(await Deno.readTextFile(cacheFile));
            expect(Array.isArray(entries)).toBe(true);
            expect(entries.length).toBeGreaterThan(0);

            const second = await cf(command);
            expect(second.code).toBe(0);
            checkStderr(second.stderr);
            expect(
              second.stdout.some((line) =>
                line.includes("[compile-byte-cache] restored")
              ),
            ).toBe(true);
            expect(
              second.stdout.some((line) => line.includes("compile-cache-hit")),
            ).toBe(true);
          });
        });
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("uses a coverage-specific cache key across cf test processes", async () => {
      const dir = await Deno.makeTempDir({
        prefix: "cf-test-compile-byte-cache-coverage-env-",
      });
      const cacheFile = join(dir, "cache.json");
      const coverageDir = join(dir, "coverage");
      const command = `test "${TEST_FILE}" --root "${FIXTURES}"`;

      try {
        await withEnv("CF_COMPILE_CACHE_FILE", cacheFile, async () => {
          await withEnv("CF_PATTERN_COVERAGE_DIR", coverageDir, async () => {
            await withEnv("CF_LOG_LEVEL", "info", async () => {
              const first = await cf(command);
              expect(first.code).toBe(0);
              checkStderr(first.stderr);

              const entries = JSON.parse(await Deno.readTextFile(cacheFile));
              expect(Array.isArray(entries)).toBe(true);
              expect(
                entries.some((entry: { key?: unknown }) =>
                  typeof entry.key === "string" &&
                  entry.key.includes("/pattern-coverage\0")
                ),
              ).toBe(true);
              expect(
                entries.some((
                  entry: { patternCoverageSpans?: unknown },
                ) => Array.isArray(entry.patternCoverageSpans)),
              ).toBe(true);

              const second = await cf(command);
              expect(second.code).toBe(0);
              checkStderr(second.stderr);
              expect(
                second.stdout.some((line) =>
                  line.includes("[compile-byte-cache] restored")
                ),
              ).toBe(true);
              expect(
                second.stdout.some((line) =>
                  line.includes("compile-cache-hit")
                ),
              ).toBe(true);

              const coverage = await readCoverageText(coverageDir);
              expect(coverage).toContain("SF:");
              expect(coverage).toMatch(/LH:[1-9]/);
            });
          });
        });
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  },
);
