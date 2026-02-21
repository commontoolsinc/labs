import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ExperimentalOptions, RuntimeOptions } from "@commontools/runner";

const VALIDATION_MSG = "ExperimentalOptions: `richStorableValues` requires";

/**
 * Build a minimal RuntimeOptions stub with the given experimental flags.
 * The stub is intentionally incomplete -- it only needs to survive long
 * enough for the constructor to reach (or pass) the flag validation.
 */
function stubOptions(experimental: ExperimentalOptions): RuntimeOptions {
  return {
    apiUrl: new URL("http://localhost:0"),
    storageManager: {} as RuntimeOptions["storageManager"],
    experimental,
  };
}

/**
 * Attempt to construct a Runtime with the given experimental flags.
 * Returns the error message if the constructor throws, or `null` if
 * something else happens (including a later unrelated crash).
 */
async function tryConstruct(
  experimental: ExperimentalOptions,
): Promise<string | null> {
  // Dynamic import so the module-level side effects don't interfere with
  // test isolation, and to import Runtime from its source location.
  const { Runtime } = await import("../src/runtime.ts");
  try {
    new Runtime(stubOptions(experimental));
  } catch (e: unknown) {
    if (e instanceof Error) return e.message;
    return String(e);
  }
  return null;
}

describe("ExperimentalOptions flag cross-validation", () => {
  it("throws when richStorableValues is true but canonicalHashing is false", async () => {
    const msg = await tryConstruct({
      richStorableValues: true,
      canonicalHashing: false,
    });
    expect(msg).toBeDefined();
    expect(msg!).toContain(VALIDATION_MSG);
  });

  it("does not throw when both richStorableValues and canonicalHashing are true", async () => {
    const msg = await tryConstruct({
      richStorableValues: true,
      canonicalHashing: true,
    });
    // May be null (no error) or an unrelated error from the incomplete
    // stub.  Either way, the validation error must NOT appear.
    if (msg !== null) {
      expect(msg).not.toContain(VALIDATION_MSG);
    }
  });

  it("does not throw when canonicalHashing is true but richStorableValues is false", async () => {
    const msg = await tryConstruct({
      richStorableValues: false,
      canonicalHashing: true,
    });
    if (msg !== null) {
      expect(msg).not.toContain(VALIDATION_MSG);
    }
  });

  it("does not throw when both flags are false (default)", async () => {
    const msg = await tryConstruct({});
    if (msg !== null) {
      expect(msg).not.toContain(VALIDATION_MSG);
    }
  });
});
