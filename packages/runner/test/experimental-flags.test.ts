import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ExperimentalOptions, RuntimeOptions } from "@commonfabric/runner";

const VALIDATION_MSG = "ExperimentalOptions: `modernDataModel` requires";

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
  it("throws when modernDataModel is true but modernHash is false", async () => {
    const msg = await tryConstruct({
      modernDataModel: true,
      modernHash: false,
    });
    expect(msg).toBeDefined();
    expect(msg!).toContain(VALIDATION_MSG);
  });

  it("does not throw when both modernDataModel and modernHash are true", async () => {
    const msg = await tryConstruct({
      modernDataModel: true,
      modernHash: true,
    });
    // May be null (no error) or an unrelated error from the incomplete
    // stub.  Either way, the validation error must NOT appear.
    if (msg !== null) {
      expect(msg).not.toContain(VALIDATION_MSG);
    }
  });

  it("does not throw when modernHash is true but modernDataModel is false", async () => {
    const msg = await tryConstruct({
      modernDataModel: false,
      modernHash: true,
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
