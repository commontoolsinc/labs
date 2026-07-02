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
  },
);
