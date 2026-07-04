import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { cancel } from "../src/cancel.ts";

describe("cancel helpers", () => {
  it("runs the cancellable cancel callback", () => {
    let calls = 0;

    cancel({
      cancel: () => {
        calls++;
      },
    });

    expect(calls).toBe(1);
  });
});
