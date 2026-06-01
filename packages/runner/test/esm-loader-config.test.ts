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

  it("an explicit option overrides; undefined is a no-op", () => {
    setEsmModuleLoaderConfig(true);
    expect(getEsmModuleLoaderConfig()).toBe(true);
    setEsmModuleLoaderConfig(undefined); // keep the current value
    expect(getEsmModuleLoaderConfig()).toBe(true);
    setEsmModuleLoaderConfig(false);
    expect(getEsmModuleLoaderConfig()).toBe(false);
  });

  it("reset restores the env-seeded default", () => {
    setEsmModuleLoaderConfig(true);
    resetEsmModuleLoaderConfig();
    expect(getEsmModuleLoaderConfig()).toBe(false);
  });
});
