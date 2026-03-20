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
  const items = wish<Default<Item[], []>>({ query: "#items" }).result!;

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

const DESTRUCTURE_ALIAS_LENGTH_SOURCE = `/// <cts-enable />
import { pattern, UI } from "commontools";

interface Person {
  name: string;
  spotPreferences: string[];
}

interface State {
  people: Person[];
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <ul>
        {state.people.map((person) => {
          const { name, spotPreferences } = person;
          return (
            <li>
              {spotPreferences.length > 0
                ? name + ": " + spotPreferences.join(", ")
                : name}
            </li>
          );
        })}
      </ul>
    ),
  };
});
`;

const ACTION_NATIVE_METHOD_SOURCE = `/// <cts-enable />
import { action, pattern, UI } from "commontools";

interface Item {
  price: number;
  tags: string[];
}

interface State {
  item: Item;
}

export default pattern<State>((state) => {
  const log = action(() => {
    console.log(state.item.price, state.item.tags.join(", "));
  });

  return {
    [UI]: <button onClick={log}>Log</button>,
  };
});
`;

const ACTION_FIND_ALIAS_SOURCE = `/// <cts-enable />
import { action, pattern, UI, Writable } from "commontools";

interface Person {
  name: string;
  spotPreferences: string[];
}

export default pattern<Record<string, never>>(() => {
  const people = Writable.of<Person[]>([]);
  const editPreferences = Writable.of("");

  const startEditPerson = action(({ name }: { name: string }) => {
    const p = people.get().find((x) => x.name === name);
    if (!p) return;
    editPreferences.set(p.spotPreferences.join(", "));
  });

  return {
    [UI]: <button onClick={startEditPerson}>Edit</button>,
  };
});
`;

const GUARDED_INLINE_HANDLER_SOURCE = `/// <cts-enable />
import { pattern, UI, Writable } from "commontools";

interface Request {
  id: string;
}

interface Row {
  req: Request | null;
  isOwn: boolean;
}

export default pattern<{ rows: Row[] }>(({ rows }) => {
  const selectedId = Writable.of("");

  return {
    [UI]: (
      <div>
        {rows.map((row) => {
          const req = row.req;
          const isOwn = row.isOwn;
          return req && isOwn
            ? (
              <button onClick={() => selectedId.set(req.id)}>
                Cancel
              </button>
            )
            : null;
        })}
      </div>
    ),
  };
});
`;

const JSX_NATIVE_MAP_IN_TERNARY_BRANCH_SOURCE = `/// <cts-enable />
import { pattern, UI } from "commontools";

interface Person {
  name: string;
  spotPreferences: string[];
}

interface State {
  people: Person[];
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <ul>
        {state.people.map((person) => {
          const { spotPreferences } = person;
          return (
            <li>
              {spotPreferences.length > 0
                ? (
                  <span>
                    Prefers: {spotPreferences.map((n) => "#" + n).join(", ")}
                  </span>
                )
                : null}
            </li>
          );
        })}
      </ul>
    ),
  };
});
`;

describe("OpaqueRef map callbacks", () => {
  it("keeps wish<Default<Array<T>, []>>().result.map() as a plain array map", async () => {
    const output = await transformSource(WISH_DEFAULT_ARRAY_SOURCE, {
      types: { "commontools.d.ts": commontools },
    });

    assertStringIncludes(output, "items.map((item) =>");
    assert(
      !output.includes("mapWithPattern("),
      "expected wish result arrays to stay plain in JSX",
    );
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

  it("lowers destructured array aliases in map callback bodies to key bindings", async () => {
    const output = await transformSource(DESTRUCTURE_ALIAS_LENGTH_SOURCE, {
      types: { "commontools.d.ts": commontools },
    });

    assertStringIncludes(output, 'const name = person.key("name")');
    assertStringIncludes(
      output,
      'spotPreferences = person.key("spotPreferences")',
    );
    assertStringIncludes(output, 'spotPreferences.key("length") > 0');
  });

  it("materializes native method receivers inside action handlers", async () => {
    const output = await transformSource(ACTION_NATIVE_METHOD_SOURCE, {
      types: { "commontools.d.ts": commontools },
    });

    assertStringIncludes(output, 'state.key("item", "tags").get().join(", ")');
  });

  it("preserves opaque aliases through find() in action handlers", async () => {
    const output = await transformSource(ACTION_FIND_ALIAS_SOURCE, {
      types: { "commontools.d.ts": commontools },
    });

    assertStringIncludes(
      output,
      'editPreferences.set(p.key("spotPreferences").get().join(", "))',
    );
  });

  it("materializes guarded handler captures at the guarded root", async () => {
    const output = await transformSource(GUARDED_INLINE_HANDLER_SOURCE, {
      types: { "commontools.d.ts": commontools },
    });

    assertStringIncludes(output, "req: req");
    assertStringIncludes(output, "selectedId.set(req.get().id)");
    assert(
      !output.includes('id: req.key("id")'),
      "expected guarded handler capture to pass the root cell instead of a nested key projection",
    );
  });

  it("derives map callback parameters and unary negations (capability-first)", async () => {
    const output = await transformSource(SOURCE, {
      types: { "commontools.d.ts": commontools },
    });

    // Map callback should be transformed to mapWithPattern with pattern()
    assertStringIncludes(output, "mapWithPattern(");
    assertStringIncludes(output, "__ctHelpers.pattern(");

    // Capability-first uses .key() accessors for element/index/params
    assertStringIncludes(output, '__ct_pattern_input.key("element")');
    assertStringIncludes(output, '__ct_pattern_input.key("index")');
    assertStringIncludes(output, '__ct_pattern_input.key("params", "state")');

    // Captures object passes state.defaultName via .key()
    assertStringIncludes(output, "defaultName: state.key(");

    // Index arithmetic still gets derive wrapping
    assertStringIncludes(output, "({ index }) => index + 1)");

    // charm[NAME] || defaultName lowered to unless()
    assertStringIncludes(output, "__ctHelpers.unless(");
    assertStringIncludes(output, "({ charm }) => charm[NAME]");

    // ifElse negation still gets derive
    assertStringIncludes(output, "({ state }) => !state.charms.length");
  });

  it("wraps ternary JSX branches with native array maps at the branch boundary", async () => {
    const output = await transformSource(
      JSX_NATIVE_MAP_IN_TERNARY_BRANCH_SOURCE,
      {
        types: { "commontools.d.ts": commontools },
      },
    );

    assertStringIncludes(
      output,
      'spotPreferences = person.key("spotPreferences")',
    );
    assertStringIncludes(
      output,
      "__ctHelpers.ifElse(",
    );
    assertStringIncludes(
      output,
      'spotPreferences.key("length") > 0, __ctHelpers.derive(',
    );
    assertStringIncludes(
      output,
      "({ spotPreferences }) => <span>",
    );
    assertStringIncludes(
      output,
      'Prefers: {(spotPreferences ?? []).map((n) => "#" + n).join(", ")}',
    );
    assert(
      !output.includes("Prefers: {__ctHelpers.derive("),
      "expected the whole ternary branch to own the derive instead of the nested JSX slot",
    );
    assert(
      !output.includes("spotPreferences.get().map"),
      "expected ternary branch derive to keep the array map plain inside compute context",
    );
  });
});
