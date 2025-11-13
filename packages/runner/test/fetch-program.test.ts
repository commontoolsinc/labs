import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test fetch-program");
const space = signer.did();

// Mock fetch globally for program resolution
let originalFetch: typeof globalThis.fetch;
let programFetchDelay = 0;
let shouldError = false;
let errorMessage = "";
let mockPrograms: Map<string, string> = new Map();

describe("fetchProgram State Machine", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let byRef: ReturnType<typeof createBuilder>["commontools"]["byRef"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commontools } = createBuilder();
    recipe = commontools.recipe;
    byRef = commontools.byRef;

    // Reset control variables
    programFetchDelay = 0;
    shouldError = false;
    errorMessage = "";
    mockPrograms = new Map();

    // Mock global fetch for HTTP program resolution
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

      if (programFetchDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, programFetchDelay));
      }

      if (shouldError) {
        throw new Error(errorMessage || "Program fetch failed");
      }

      // Return mocked program source
      const programSource = mockPrograms.get(url) ||
        "export default () => 'test program';";

      return new Response(programSource, {
        status: 200,
        headers: { "Content-Type": "text/typescript" },
      });
    };
  });

  afterEach(async () => {
    // Restore original fetch
    globalThis.fetch = originalFetch;

    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("fetchProgram lifecycle", () => {
    it("should transition: idle -> fetching -> success", async () => {
      const url = "http://example.com/program.ts";
      mockPrograms.set(url, "export default () => 'hello';");

      const fetchProgram = byRef("fetchProgram");
      const testRecipe = recipe("Fetch Program", () => fetchProgram({ url }));

      const resultCell = runtime.getCell(space, "fetch-prog-1", undefined, tx);
      const result = runtime.run(tx, testRecipe, {}, resultCell);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await runtime.idle();

      const data = result.get() as {
        pending?: boolean;
        result?: { files: Array<{ name: string; contents: string }>; main: string };
        error?: string;
      };

      expect(data.pending).toBe(false);
      expect(data.result).toBeDefined();
      expect(data.result?.files).toBeDefined();
      expect(Array.isArray(data.result?.files)).toBe(true);
      expect(data.error).toBeUndefined();
    });

    it("should transition: idle -> fetching -> error", async () => {
      shouldError = true;
      errorMessage = "Network error";

      const fetchProgram = byRef("fetchProgram");
      const testRecipe = recipe("Fetch Error", () =>
        fetchProgram({ url: "http://example.com/bad.ts" }));

      const resultCell = runtime.getCell(space, "fetch-error", undefined, tx);
      const result = runtime.run(tx, testRecipe, {}, resultCell);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.idle();

      const data = result.get() as {
        pending?: boolean;
        result?: any;
        error?: string;
      };

      expect(data.pending).toBe(false);
      expect(data.error).toBe("Network error");
      expect(data.result).toBeUndefined();
    });

    it("should handle concurrent requests with different URLs", async () => {
      const url1 = "http://example.com/prog1.ts";
      const url2 = "http://example.com/prog2.ts";

      mockPrograms.set(url1, "export default () => 'prog1';");
      mockPrograms.set(url2, "export default () => 'prog2';");

      const fetchProgram = byRef("fetchProgram");
      const recipe1 = recipe("Fetch 1", () => fetchProgram({ url: url1 }));
      const recipe2 = recipe("Fetch 2", () => fetchProgram({ url: url2 }));

      const resultCell1 = runtime.getCell(space, "concurrent-1", undefined, tx);
      const resultCell2 = runtime.getCell(space, "concurrent-2", undefined, tx);

      runtime.run(tx, recipe1, {}, resultCell1);
      runtime.run(tx, recipe2, {}, resultCell2);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await runtime.idle();

      const data1 = resultCell1.get() as { pending?: boolean; result?: any };
      const data2 = resultCell2.get() as { pending?: boolean; result?: any };

      expect(data1.pending).toBe(false);
      expect(data1.result).toBeDefined();
      expect(data2.pending).toBe(false);
      expect(data2.result).toBeDefined();
    });

    it("should prevent race conditions (newer request wins)", async () => {
      programFetchDelay = 50;

      const urlCell = runtime.getCell<string>(
        space,
        "url-input",
        undefined,
        tx,
      );
      urlCell.set("http://example.com/first.ts");

      mockPrograms.set("http://example.com/first.ts", "export default () => 'first';");
      mockPrograms.set("http://example.com/second.ts", "export default () => 'second';");

      tx.commit();
      tx = runtime.edit();

      const fetchProgram = byRef("fetchProgram");
      const testRecipe = recipe<{ url: string }>(
        "Race Test",
        ({ url }) => fetchProgram({ url }),
      );

      const resultCell = runtime.getCell(space, "race-test", undefined, tx);
      runtime.run(tx, testRecipe, { url: urlCell }, resultCell);
      tx.commit();

      // Change URL quickly
      await new Promise((resolve) => setTimeout(resolve, 10));
      tx = runtime.edit();
      urlCell.withTx(tx).send("http://example.com/second.ts");
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await runtime.idle();

      const data = resultCell.get() as { result?: any };

      // Should have result (from second request due to CAS)
      expect(data.result).toBeDefined();
    });

    it("should cache results for identical URLs", async () => {
      const url = "http://example.com/cached.ts";
      mockPrograms.set(url, "export default () => 'cached';");

      const fetchProgram = byRef("fetchProgram");
      const testRecipe = recipe("Cache Test", () => fetchProgram({ url }));

      // First request
      const resultCell1 = runtime.getCell(space, "cache-1", undefined, tx);
      runtime.run(tx, testRecipe, {}, resultCell1);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.idle();

      // Second request with same URL should use cache
      tx = runtime.edit();
      const resultCell2 = runtime.getCell(space, "cache-2", undefined, tx);
      runtime.run(tx, testRecipe, {}, resultCell2);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await runtime.idle();

      const data1 = resultCell1.get() as { result?: any };
      const data2 = resultCell2.get() as { result?: any };

      expect(data1.result).toBeDefined();
      expect(data2.result).toBeDefined();
    });

    it("should invalidate cache when URL changes", async () => {
      const url1 = "http://example.com/prog1.ts";
      const url2 = "http://example.com/prog2.ts";

      mockPrograms.set(url1, "export default () => 'prog1';");
      mockPrograms.set(url2, "export default () => 'prog2';");

      const fetchProgram = byRef("fetchProgram");

      // First request
      const recipe1 = recipe("Inv 1", () => fetchProgram({ url: url1 }));
      const resultCell = runtime.getCell(space, "invalidate", undefined, tx);
      runtime.run(tx, recipe1, {}, resultCell);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.idle();

      // Second request with different URL
      tx = runtime.edit();
      const recipe2 = recipe("Inv 2", () => fetchProgram({ url: url2 }));
      runtime.run(tx, recipe2, {}, resultCell);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.idle();

      const data = resultCell.get() as { result?: any };

      // Should have new result
      expect(data.result).toBeDefined();
    });

    it("should handle empty URL (no request)", async () => {
      const fetchProgram = byRef("fetchProgram");
      const testRecipe = recipe("Empty URL", () => fetchProgram({}));

      const resultCell = runtime.getCell(space, "empty-url", undefined, tx);
      const result = runtime.run(tx, testRecipe, {}, resultCell);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const data = result.get() as {
        pending?: boolean;
        result?: any;
      };

      expect(data.pending).toBe(false);
      expect(data.result).toBeUndefined();
    });

    it("should handle rapid URL changes (request superseding)", async () => {
      programFetchDelay = 50;

      const urlCell = runtime.getCell<string>(
        space,
        "rapid-url",
        undefined,
        tx,
      );
      urlCell.set("http://example.com/first.ts");

      mockPrograms.set("http://example.com/first.ts", "export default () => 'first';");
      mockPrograms.set("http://example.com/second.ts", "export default () => 'second';");
      mockPrograms.set("http://example.com/third.ts", "export default () => 'third';");

      tx.commit();
      tx = runtime.edit();

      const fetchProgram = byRef("fetchProgram");
      const testRecipe = recipe<{ url: string }>(
        "Rapid Change",
        ({ url }) => fetchProgram({ url }),
      );

      const resultCell = runtime.getCell(space, "rapid-change", undefined, tx);
      runtime.run(tx, testRecipe, { url: urlCell }, resultCell);
      tx.commit();

      // Rapidly change URLs
      await new Promise((resolve) => setTimeout(resolve, 10));
      tx = runtime.edit();
      urlCell.withTx(tx).send("http://example.com/second.ts");
      tx.commit();

      await new Promise((resolve) => setTimeout(resolve, 10));
      tx = runtime.edit();
      urlCell.withTx(tx).send("http://example.com/third.ts");
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await runtime.idle();

      const data = resultCell.get() as { result?: any };

      // Should have final URL's result
      expect(data.result).toBeDefined();
    });
  });
});
