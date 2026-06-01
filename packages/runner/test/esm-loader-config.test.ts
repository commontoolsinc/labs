import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  getEsmModuleLoaderConfig,
  resetEsmModuleLoaderConfig,
  setEsmModuleLoaderConfig,
} from "../src/sandbox/esm-loader-config.ts";

// CF_ESM_MODULE_LOADER is unset in the normal test process, so the env-seeded
// default is `false`. (The env-on path is exercised by running the suite with
// CF_ESM_MODULE_LOADER=1 — the regression cross-check.)
describe("esm-loader-config", () => {
  afterEach(() => resetEsmModuleLoaderConfig());

  it("defaults off when CF_ESM_MODULE_LOADER is unset", () => {
    resetEsmModuleLoaderConfig();
    expect(getEsmModuleLoaderConfig()).toBe(false);
  });

  it("an explicit option overrides; undefined falls back to the env default", () => {
    setEsmModuleLoaderConfig(true);
    expect(getEsmModuleLoaderConfig()).toBe(true);
    // No prior-value inheritance: undefined re-reads the env default (off here),
    // so a Runtime without the option never sees a stale override.
    setEsmModuleLoaderConfig(undefined);
    expect(getEsmModuleLoaderConfig()).toBe(false);
    setEsmModuleLoaderConfig(false);
    expect(getEsmModuleLoaderConfig()).toBe(false);
  });

  it("reset restores the env-seeded default", () => {
    setEsmModuleLoaderConfig(true);
    resetEsmModuleLoaderConfig();
    expect(getEsmModuleLoaderConfig()).toBe(false);
  });
});
