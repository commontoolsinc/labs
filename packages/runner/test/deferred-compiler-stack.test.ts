import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

// The deferred compiler stack's contract has two halves: flows that parse or
// compile await `ensureCompilerStack()` once at their entry, and the sync
// internals under them reach values through `compilerStack()` — which must
// FAIL LOUD if some future flow forgets its ensure, rather than silently
// re-eagering the compiler onto the worker boot path. Pin both halves.
//
// The module memoizes process-globally (by design), and other test files
// preload it — so import a FRESH instance via a cache-busting query to
// observe the pre-load state.

describe("deferred compiler stack", () => {
  it("compilerStack() throws with instructions before any flow ensured", async () => {
    const fresh = await import(
      "../src/harness/deferred-compiler-stack.ts?virgin"
    );
    expect(() => fresh.compilerStack()).toThrow(
      /await ensureCompilerStack\(\)/,
    );

    const stack = await fresh.ensureCompilerStack();
    // Loaded: the accessor now returns the same module the ensure resolved,
    // and ensure is memoized (idempotent across flows).
    expect(fresh.compilerStack()).toBe(stack);
    expect(await fresh.ensureCompilerStack()).toBe(stack);
    // The stack carries the compiler surface the runner's flows reach for.
    expect(typeof stack.ts.createSourceFile).toBe("function");
    expect(typeof stack.TypeScriptCompiler).toBe("function");
    expect(typeof stack.collectImportSpecifiers).toBe("function");
  });
});
