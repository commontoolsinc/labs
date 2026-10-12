import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { patternTestExperimentalOptions } from "../lib/pattern-test-experimental-options.ts";

/** An environment reader over `vars` alone. */
function envOf(
  vars: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => vars[name];
}

describe("patternTestExperimentalOptions()", () => {
  it("throws naming the missing serving loop when the environment turns server execution on", () => {
    expect(() =>
      patternTestExperimentalOptions(
        envOf({ EXPERIMENTAL_SERVER_EXECUTION: "true" }),
      )
    ).toThrow(
      "`cf test` refuses `EXPERIMENTAL_SERVER_EXECUTION=true`: it hosts no serving loop",
    );
  });

  it("returns `serverExecution` as `false` when the environment sets it to `false`", () => {
    expect(
      patternTestExperimentalOptions(
        envOf({ EXPERIMENTAL_SERVER_EXECUTION: "false" }),
      ),
    ).toStrictEqual({ serverExecution: false });
  });

  it("returns no `serverExecution` when the environment leaves it unset", () => {
    expect(patternTestExperimentalOptions(envOf({}))).toStrictEqual({});
  });

  it("returns the other flags the environment sets", () => {
    expect(
      patternTestExperimentalOptions(
        envOf({
          EXPERIMENTAL_MODERN_CELL_REP: "true",
          EXPERIMENTAL_LAZY_MATERIALIZATION: "false",
        }),
      ),
    ).toStrictEqual({ modernCellRep: true, lazyMaterialization: false });
  });
});
