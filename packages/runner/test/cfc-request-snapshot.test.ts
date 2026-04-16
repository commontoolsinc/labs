import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";

describe("CFC request snapshots", () => {
  it("creates a detached immutable snapshot", () => {
    const request = {
      url: "https://example.com/data",
      options: {
        method: "POST",
        headers: {
          "x-test": "initial",
        },
        body: {
          nested: ["a", "b"],
        },
      },
    };

    const snapshot = createFrozenRequestSnapshot(request);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.options)).toBe(true);
    expect(Object.isFrozen(snapshot.options.headers)).toBe(true);
    expect(Object.isFrozen(snapshot.options.body)).toBe(true);
    expect(snapshot).toEqual(request);

    request.options.headers["x-test"] = "changed";
    (request.options.body.nested as string[]).push("c");

    expect(snapshot.options.headers["x-test"]).toBe("initial");
    expect(snapshot.options.body.nested).toEqual(["a", "b"]);
  });
});
