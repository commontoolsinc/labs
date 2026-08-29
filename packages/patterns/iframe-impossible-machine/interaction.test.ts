import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { stopNodeControlPropagation } from "./interaction.ts";

describe("stopNodeControlPropagation()", () => {
  it("stops a control click before React Flow selects its node", () => {
    let stopped = false;

    stopNodeControlPropagation({
      stopPropagation: () => {
        stopped = true;
      },
    });

    expect(stopped).toBe(true);
  });
});
