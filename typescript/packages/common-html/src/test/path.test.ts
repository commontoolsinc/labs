import { equal as assertEqual } from "node:assert/strict";
import { path, KeyPath, Pathable } from "../path.js";

describe("path", () => {
  it("gets a deep path from any object", () => {
    const obj = {
      a: {
        b: [{ c: 10 }],
      },
    };
    assertEqual(path(obj, ["a", "b", 0, "c"]), 10);
  });

  it("returns undefined when any part of the path does not exist", () => {
    assertEqual(path({}, ["a", "b", 0, "c"]), undefined);
  });

  it("defers to `path()` implementation for Pathable types", () => {
    class Wrapper<T> implements Pathable {
      #subject: T;

      constructor(subject: T) {
        this.#subject = subject;
      }

      path(keyPath: KeyPath): unknown {
        return path(this.#subject, keyPath);
      }
    }

    const obj = {
      a: {
        b: [{ c: 10 }],
      },
    };

    const wrapper = new Wrapper(obj);

    assertEqual(path(wrapper, ["a", "b", 0, "c"]), 10);
  });
});
