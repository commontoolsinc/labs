import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  acquireReaderSchemaPrecedenceDisabler,
  getReaderSchemaPrecedenceConfig,
  resetReaderSchemaPrecedenceConfig,
} from "../src/reader-schema-precedence-config.ts";

describe("reader-schema-precedence-config", () => {
  afterEach(() => {
    resetReaderSchemaPrecedenceConfig();
  });

  it("returns false while a claim is live and true after its release", () => {
    const release = acquireReaderSchemaPrecedenceDisabler();
    expect(getReaderSchemaPrecedenceConfig()).toBe(false);
    release();
    expect(getReaderSchemaPrecedenceConfig()).toBe(true);
  });

  it("releases idempotently", () => {
    const releaseA = acquireReaderSchemaPrecedenceDisabler();
    const releaseB = acquireReaderSchemaPrecedenceDisabler();
    releaseA();
    releaseA();
    expect(getReaderSchemaPrecedenceConfig()).toBe(false);
    releaseB();
    expect(getReaderSchemaPrecedenceConfig()).toBe(true);
  });

  it("keeps an abandoned claim's release from reaching a later epoch", () => {
    const stale = acquireReaderSchemaPrecedenceDisabler();
    resetReaderSchemaPrecedenceConfig();
    // The stale release must not decrement the fresh epoch's count to -1 —
    // a claim acquired after the reset must still hold the rollback.
    stale();
    expect(getReaderSchemaPrecedenceConfig()).toBe(true);
    const live = acquireReaderSchemaPrecedenceDisabler();
    expect(getReaderSchemaPrecedenceConfig()).toBe(false);
    live();
    expect(getReaderSchemaPrecedenceConfig()).toBe(true);
  });
});
