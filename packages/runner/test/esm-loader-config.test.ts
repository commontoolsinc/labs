import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  getEsmModuleLoaderConfig,
  resetEsmModuleLoaderConfig,
  setEsmModuleLoaderConfig,
} from "../src/sandbox/esm-loader-config.ts";

// The env-seeded default depends on CF_ESM_MODULE_LOADER, which is unset in the
// normal test process but SET during the flag-on cross-check
// (CF_ESM_MODULE_LOADER=1). Compute the expected default from the env so these
// assertions are deterministic under both — testing the set/get/reset mechanics
// relative to whatever the env default is, not a hardcoded value.
const envDefault: boolean = (() => {
  try {
    const v = (globalThis as {
      Deno?: { env?: { get(name: string): string | undefined } };
    }).Deno?.env?.get?.("CF_ESM_MODULE_LOADER");
    // Mirror readEnvDefault: ON by default unless explicitly "0"/"false".
    return v !== "0" && v !== "false";
  } catch {
    return true;
  }
})();

describe("esm-loader-config", () => {
  afterEach(() => resetEsmModuleLoaderConfig());

  it("defaults to the CF_ESM_MODULE_LOADER env value", () => {
    resetEsmModuleLoaderConfig();
    expect(getEsmModuleLoaderConfig()).toBe(envDefault);
  });

  it("an explicit option overrides; undefined falls back to the env default", () => {
    setEsmModuleLoaderConfig(!envDefault); // explicit, opposite of env default
    expect(getEsmModuleLoaderConfig()).toBe(!envDefault);
    setEsmModuleLoaderConfig(undefined); // no stale inheritance → env default
    expect(getEsmModuleLoaderConfig()).toBe(envDefault);
    setEsmModuleLoaderConfig(envDefault);
    expect(getEsmModuleLoaderConfig()).toBe(envDefault);
  });

  it("reset restores the env-seeded default", () => {
    setEsmModuleLoaderConfig(!envDefault);
    resetEsmModuleLoaderConfig();
    expect(getEsmModuleLoaderConfig()).toBe(envDefault);
  });
});
