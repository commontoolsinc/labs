import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createCancelGroup } from "../src/shared/cancel.ts";

describe("cleanupGroup", () => {
  it("should create a cleanup group with add and cleanup methods", () => {
    const group = createCancelGroup();
    expect(typeof group.add).toBe("function");
    expect(typeof group).toBe("function");
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

    expect(count).toEqual(2);
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

    expect(count).toEqual(2);
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

    expect(count).toEqual(2);
  });

  it("should handle empty cleanup group", () => {
    const group = createCancelGroup();
    expect(() => group()).not.toThrow();
  });
});
