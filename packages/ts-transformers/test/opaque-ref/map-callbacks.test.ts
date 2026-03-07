import { describe, it } from "@std/testing/bdd";
import { assert, assertStringIncludes } from "@std/assert";
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

const WISH_DEFAULT_ARRAY_SOURCE = `/// <cts-enable />
import { Default, handler, NAME, pattern, UI, wish, Writable } from "commontools";

type Item = { name: string; value: number };

const removeItem = handler<
  Record<string, never>,
  { items: Writable<Default<Item[], []>>; item: Item }
>((_, { items, item }) => {
  items.remove(item);
});

export default pattern<Record<string, never>>((_) => {
  const { result: items } = wish<Default<Item[], []>>({ query: "#items" });

  return {
    [NAME]: "Test",
    [UI]: (
      <ul>
        {items.map((item) => (
          <li>
            {item.name}
            <button onClick={removeItem({ items, item })}>Remove</button>
          </li>
        ))}
      </ul>
    ),
  };
});
`;

const DESTRUCTURE_ALIAS_SOURCE = `/// <cts-enable />
import { pattern, UI } from "commontools";

interface Spot {
  spotNumber: string;
}

interface State {
  spots: Spot[];
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <ul>
        {state.spots.map((spot) => {
          const { spotNumber: sn } = spot;
          return <li>{sn}</li>;
        })}
      </ul>
    ),
  };
});
`;

describe("OpaqueRef map callbacks", () => {
  it("transforms wish<Default<Array<T>, []>>().result.map() to mapWithPattern", async () => {
    const output = await transformSource(WISH_DEFAULT_ARRAY_SOURCE, {
      types: { "commontools.d.ts": commontools },
    });

    // The map should be transformed to mapWithPattern, not left as .map()
    assertStringIncludes(output, "mapWithPattern(");
    // The outer items capture should appear in params
    assertStringIncludes(output, "items: items");
  });

  it("does not capture destructuring property keys as variables (alias bug)", async () => {
    const output = await transformSource(DESTRUCTURE_ALIAS_SOURCE, {
      types: { "commontools.d.ts": commontools },
    });

    // The map callback should NOT capture "spotNumber" as a variable.
    // "spotNumber" in `{ spotNumber: sn }` is a property key, not a variable reference.
    // If the bug were present, the output would contain `spotNumber: spotNumber` or
    // `spotNumber` in the captures object, causing a ReferenceError at runtime.
    const mapStart = output.indexOf("mapWithPattern(");
    assert(
      mapStart !== -1,
      "expected map() to be transformed to mapWithPattern",
    );
    const mapSection = output.slice(mapStart);
    assert(
      !mapSection.includes("spotNumber: spotNumber"),
      "should not capture destructuring property key 'spotNumber' as a variable",
    );
    // The captures object (last arg to mapWithPattern) must be empty
    assertStringIncludes(output, "), {})");
  });
});
