import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { isOpaqueRef } from "../src/builder/types.ts";
import { opaqueRef } from "../src/builder/opaque-ref.ts";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Identity } from "@commontools/identity";

const signer = await Identity.fromPassphrase("test operator");

describe("opaqueRef function", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
  });

  it("creates an opaque ref", () => {
    const c = opaqueRef<number>();
    expect(isOpaqueRef(c)).toBe(true);
  });

  it("throws on get", () => {
    const c = opaqueRef<number>();
    // Use type assertion since .get() is no longer on OpaqueRef type
    // but we want to verify runtime still throws
    expect(() => (c as any).get()).toThrow();
  });
});
