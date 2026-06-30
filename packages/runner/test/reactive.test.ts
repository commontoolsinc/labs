import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { isReactive } from "../src/builder/types.ts";
import { reactive } from "../src/builder/reactive.ts";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Identity } from "@commonfabric/identity";

const signer = await Identity.fromPassphrase("test operator");

describe("reactive function", () => {
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
    const c = reactive<number>();
    expect(isReactive(c)).toBe(true);
  });

  it("throws on get", () => {
    const c = reactive<number>();
    // Use type assertion since .get() is no longer on Reactive type
    // but we want to verify runtime still throws
    expect(() => (c as any).get()).toThrow();
  });
});
