import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join, resolve } from "@std/path";
import type { CompiledModuleArtifact } from "@commonfabric/runner";
import {
  ProcessModuleByteCache,
  restoreCompileByteCacheForTesting,
  writeCompileByteCacheForTesting,
} from "@commonfabric/test-support/compile-byte-cache";
import { runMultiUserTestPattern } from "../lib/multi-user-test-runner.ts";
import { runTests } from "../lib/test-runner.ts";
import { cf, checkStderr, withEnv } from "./utils.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/pattern-coverage");
const TEST_FILE = join(FIXTURES, "single.test.tsx").replaceAll("\\", "/");
const COMPILE_BYTE_CACHE_MODULE = new URL(
  "../lib/compile-byte-cache.ts",
  import.meta.url,
);

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

async function importFreshCompileByteCacheModule(): Promise<
  typeof import("../lib/compile-byte-cache.ts")
> {
  const url = new URL(COMPILE_BYTE_CACHE_MODULE);
  url.searchParams.set("testRun", crypto.randomUUID());
  return await import(url.href);
}

describe(
  "cf test compile byte cache",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("flushes safely before the default cache is initialized", async () => {
      const module = await importFreshCompileByteCacheModule();

      module.flushDefaultModuleByteCache();
    });

    it("flushes the default cache to CF_COMPILE_CACHE_FILE", async () => {
      const dir = await Deno.makeTempDir({
        prefix: "cf-test-default-compile-byte-cache-",
      });
      const cacheFile = join(dir, "cache.json");

      try {
        await withEnv("CF_COMPILE_CACHE_FILE", cacheFile, async () => {
          const module = await importFreshCompileByteCacheModule();
          const cache = module.getDefaultModuleByteCache();
          cache.putAll("rt", [{ identity: "id", js: "JS" }]);

          module.flushDefaultModuleByteCache();

          const entries = JSON.parse(await Deno.readTextFile(cacheFile));
          expect(entries).toEqual([{ key: "rt\0id", js: "JS" }]);
        });
      } finally {
        globalThis.addEventListener("unload", () => {
          try {
            Deno.removeSync(dir, { recursive: true });
          } catch {
            // The test may have already removed the directory.
          }
        });
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
    });

    it("reports default cache flush failures", async () => {
      const dir = await Deno.makeTempDir({
        prefix: "cf-test-default-compile-byte-cache-error-",
      });
      const cacheFile = join(dir, "cache.json");
      const originalOpenSync = Deno.openSync;
      const originalError = console.error;
      const errors: string[] = [];

      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };

      try {
        await withEnv("CF_COMPILE_CACHE_FILE", cacheFile, async () => {
          const module = await importFreshCompileByteCacheModule();
          const cache = module.getDefaultModuleByteCache();
          cache.putAll("rt", [{ identity: "id", js: "JS" }]);

          Deno.openSync = (() => {
            throw new Error("lock unavailable");
          }) as typeof Deno.openSync;
          module.flushDefaultModuleByteCache();
        });

        expect(
          errors.some((line) =>
            line.includes("[compile-byte-cache] failed to write cache file:")
          ),
        ).toBe(true);
      } finally {
        Deno.openSync = originalOpenSync;
        console.error = originalError;
        globalThis.addEventListener("unload", () => {
          try {
            Deno.removeSync(dir, { recursive: true });
          } catch {
            // The test may have already removed the directory.
          }
        });
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
    });

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

    it("flushes a multi-user worker cache when participant init fails", async () => {
      const dir = await Deno.makeTempDir({
        prefix: "cf-test-multi-user-init-failure-",
      });
      const missingTest = join(dir, "missing.test.tsx");
      const cacheFile = join(dir, "cache.json");

      try {
        let result:
          | Awaited<ReturnType<typeof runMultiUserTestPattern>>
          | undefined;
        await withEnv("CF_COMPILE_CACHE_FILE", cacheFile, async () => {
          result = await runMultiUserTestPattern(
            missingTest,
            { participants: [{ name: "alice", user: "alice" }] },
            { root: dir },
          );
        });

        if (result === undefined) throw new Error("missing test result");
        expect(result.error).toBeDefined();
        expect(JSON.parse(await Deno.readTextFile(cacheFile))).toEqual([]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  },
);
