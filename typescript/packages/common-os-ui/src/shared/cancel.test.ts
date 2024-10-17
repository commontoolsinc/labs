import { createCancelGroup } from "./cancel.js";
import * as assert from "node:assert/strict";

describe("cleanupGroup", () => {
  it("should create a cleanup group with add and cleanup methods", () => {
    const group = createCancelGroup();
    assert.equal(typeof group.add, "function");
    assert.equal(typeof group, "function");
  });

  it("should execute added cleanup functions when cleanup is called", () => {
    const group = createCancelGroup();
    let count = 0;

    group.add(() => {
      count++;
    });
    group.add(() => {
      count++;
    });

    group();

    assert.equal(count, 2);
  });

  it("should not execute cleanup functions more than once", () => {
    const group = createCancelGroup();
    let count = 0;

    group.add(() => {
      count++;
    });
    group.add(() => {
      count++;
    });

    group();
    group();

    assert.equal(count, 2);
  });

  it("should allow adding cleanup functions after cleanup has been called", () => {
    const group = createCancelGroup();
    let count = 0;

    group.add(() => {
      count++;
    });
    group();

    group.add(() => {
      count++;
    });
    group();

    assert.equal(count, 2);
  });

  it("should handle empty cleanup group", () => {
    const group = createCancelGroup();
    assert.doesNotThrow(() => group());
  });
});
