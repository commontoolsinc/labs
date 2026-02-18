import { describe, it } from "@std/testing/bdd";
import { assertStringIncludes } from "@std/assert";
import { StaticCacheFS } from "@commontools/static";

import { transformSource } from "../utils.ts";

const staticCache = new StaticCacheFS();
const commontools = await staticCache.getText("types/commontools.d.ts");

const SOURCE = `/// <cts-enable />
import { h, pattern, UI, ifElse, NAME } from "commontools";

interface Charm {
  id: string;
  [key: string]: string | undefined;
}

interface State {
  charms: Charm[];
  defaultName: string;
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <section>
        <ul>
          {state.charms.map((charm: any, index: number) => (
            <li key={charm.id}>
              <span class="number">{index + 1}</span>
              <span class="name">{charm[NAME] || state.defaultName}</span>
            </li>
          ))}
        </ul>
        {ifElse(!state.charms.length, <p>No charms</p>, <p>Loaded charms</p>)}
      </section>
    ),
  };
});
`;

describe("OpaqueRef map callbacks", () => {
  it("derives map callback parameters and unary negations", async () => {
    const output = await transformSource(SOURCE, {
      types: { "commontools.d.ts": commontools },
    });

    // Map callback should be transformed to pattern with function-first, then schema for captured defaultName
    assertStringIncludes(
      output,
      "__ctHelpers.pattern(",
    );
    // Check for correct parameter destructuring
    assertStringIncludes(
      output,
      "({ element: charm, index, params: { state } }) =>",
    );
    assertStringIncludes(
      output,
      "state: {\n                    defaultName: state.defaultName\n                }",
    );
    // Index parameter still gets derive wrapping for the arithmetic operation
    assertStringIncludes(
      output,
      `__ctHelpers.derive({
                type: "object",
                properties: {
                    index: {
                        type: "number"
                    }
                },
                required: ["index"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "number"
            } as const satisfies __ctHelpers.JSONSchema, { index: index }, ({ index }) => index + 1)`,
    );
    // element[NAME] || defaultName - since right side is not JSX, wraps whole expression in derive
    // (unless optimization only applies when right side is expensive like JSX)
    assertStringIncludes(
      output,
      "({ charm, state }) => charm[NAME] || state.defaultName",
    );
    // ifElse still gets derive for the negation and preserves callback body
    assertStringIncludes(
      output,
      "({ state }) => !state.charms.length",
    );
  });
});
