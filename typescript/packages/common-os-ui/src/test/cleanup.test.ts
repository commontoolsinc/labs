import { createCleanupGroup } from "../shared/cleanup.js";
import * as assert from "node:assert/strict";

describe("cleanupGroup", () => {
  it("should create a cleanup group with add and cleanup methods", () => {
    const group = createCleanupGroup();
    assert.equal(typeof group.add, "function");
    assert.equal(typeof group.cleanup, "function");
  });

  it("should execute added cleanup functions when cleanup is called", () => {
    const group = createCleanupGroup();
    let count = 0;

    group.add(() => {
      count++;
    });
    group.add(() => {
      count++;
    });

    group.cleanup();

    assert.equal(count, 2);
  });

  it("should not execute cleanup functions more than once", () => {
    const group = createCleanupGroup();
    let count = 0;

    group.add(() => {
      count++;
    });
    group.add(() => {
      count++;
    });

    group.cleanup();
    group.cleanup();

    assert.equal(count, 2);
  });

  it("should allow adding cleanup functions after cleanup has been called", () => {
    const group = createCleanupGroup();
    let count = 0;

    group.add(() => {
      count++;
    });
    group.cleanup();

    group.add(() => {
      count++;
    });
    group.cleanup();

    assert.equal(count, 2);
  });

  it("should handle empty cleanup group", () => {
    const group = createCleanupGroup();
    assert.doesNotThrow(() => group.cleanup());
  });
});
