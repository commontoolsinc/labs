import { describe, it } from "@std/testing/bdd";
import { assertStringIncludes } from "@std/assert";
import { StaticCache } from "@commontools/static";

import { transformSource } from "../utils.ts";

const staticCache = new StaticCache();
const commontools = await staticCache.getText("types/commontools.d.ts");

const SOURCE = `/// <cts-enable />
import { h, recipe, UI, ifElse, NAME } from "commontools";

interface Charm {
  id: string;
  [key: string]: string | undefined;
}

interface State {
  charms: Charm[];
  defaultName: string;
}

export default recipe<State>("CharmList", (state) => {
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

    // Map callback should be transformed to recipe with params for captured defaultName
    assertStringIncludes(
      output,
      'recipe("map with pattern including captures", ({ elem, index, params: { defaultName } }) =>',
    );
    assertStringIncludes(
      output,
      "{ defaultName: state.defaultName }",
    );
    // Index parameter still gets derive wrapping for the arithmetic operation
    assertStringIncludes(
      output,
      "derive(index, index => index + 1)",
    );
    // elem[NAME] uses NAME from module scope (import), defaultName from params
    assertStringIncludes(
      output,
      "elem[NAME] || defaultName",
    );
    // ifElse still gets derive for the negation
    assertStringIncludes(
      output,
      "ifElse(derive(state.charms.length, _v1 => !_v1)",
    );
  });
});
