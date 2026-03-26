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

const DESTRUCTURE_ALIAS_NESTED_PLAIN_MAP_SOURCE = `/// <cts-enable />
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
              <span>{name}</span>
              {spotPreferences.length > 0
                ? <span>{spotPreferences.map((n) => "#" + n).join(", ")}</span>
                : null}
            </li>
          );
        })}
      </ul>
    ),
  };
});
`;

const NESTED_REACTIVE_ROOT_MAP_SOURCE = `/// <cts-enable />
import { pattern, UI, Writable } from "commontools";

interface Task {
  label: string;
  done: boolean;
  tags: string[];
}

interface Section {
  title: string;
  tasks: Task[];
}

interface State {
  sections: Writable<Section[]>;
  showCompleted: boolean;
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.sections.map((section) => (
          <section>
            {section.tasks.map((task, taskIndex) => (
              <div>
                {task.tags.map((tag, tagIndex) => (
                  <span>
                    {tagIndex === taskIndex
                      ? section.title + ":" + tag
                      : state.showCompleted || !task.done
                      ? tag
                      : ""}
                  </span>
                ))}
              </div>
            ))}
          </section>
        ))}
      </div>
    ),
  };
});
`;

const PARKING_STYLE_JOIN_SOURCE = `/// <cts-enable />
import { computed, pattern, UI } from "commontools";

interface Spot {
  active: boolean;
  spotNumber: string;
  label?: string;
}

interface Person {
  name: string;
  email: string;
  commuteMode: string;
  priorityRank: number;
  defaultSpot?: string;
  spotPreferences: string[];
  isFirst: boolean;
  isLast: boolean;
}

interface State {
  people: Person[];
  editingPersonName: string | null;
  removePersonConfirmTarget: string | null;
  spots: Spot[];
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.people.map((person) => {
          const {
            name: personName,
            email,
            commuteMode,
            priorityRank,
            defaultSpot,
            spotPreferences,
            isFirst,
            isLast,
          } = person;
          const isEditing = computed(() => state.editingPersonName === personName);
          const isRemoveConfirm = computed(() =>
            state.removePersonConfirmTarget === personName
          );
          const activeSpotOpts = computed(() =>
            state.spots
              .filter((s) => s.active)
              .map((s) => ({
                label: "#" + s.spotNumber + (s.label ? " — " + s.label : ""),
                value: s.spotNumber,
              }))
          );

          return (
            <section>
              <span>{personName}</span>
              <span>{email}</span>
              <span>{commuteMode}</span>
              <span>{priorityRank}</span>
              {defaultSpot ? <span>{defaultSpot}</span> : null}
              {isFirst ? <span>first</span> : null}
              {isLast ? <span>last</span> : null}
              {isEditing ? <span>editing</span> : null}
              {isRemoveConfirm ? <span>removing</span> : null}
              {activeSpotOpts.length > 0 ? <span>spots</span> : null}
              {spotPreferences.length > 0
                ? (
                  <span>
                    Prefers: {spotPreferences.map((n) => "#" + n).join(", ")}
                  </span>
                )
                : null}
            </section>
          );
        })}
      </div>
    ),
  };
});
`;

const GOOGLE_SCOPE_CHECKBOX_SOURCE = `/// <cts-enable />
import { pattern, UI } from "commontools";

type SelectedScopes = {
  gmail: boolean;
  calendar: boolean;
};

const SCOPE_DESCRIPTIONS = {
  gmail: "Gmail",
  calendar: "Calendar",
} as const;

interface Input {
  selectedScopes: SelectedScopes;
}

export default pattern<Input>(({ selectedScopes }) => {
  return {
    [UI]: (
      <div>
        {Object.entries(SCOPE_DESCRIPTIONS).map(([key, description]) => (
          <label>
            <ct-checkbox $checked={selectedScopes[key as keyof SelectedScopes]}>
              {description}
            </ct-checkbox>
          </label>
        ))}
      </div>
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

  it("lowers destructured array aliases in map callback bodies to key access", async () => {
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

  it("does not re-derive nested plain-array callbacks inside derive-owned joins", async () => {
    const output = await transformSource(
      DESTRUCTURE_ALIAS_NESTED_PLAIN_MAP_SOURCE,
      {
        types: { "commontools.d.ts": commontools },
      },
    );
    const normalized = output.replace(/\s+/g, " ");

    assertStringIncludes(
      normalized,
      'spotPreferences.map((n) => "#" + n).join(", ")',
    );
    assert(
      !normalized.includes("spotPreferences.map((n) => __ctHelpers.derive("),
      "nested plain-array callbacks inside derive-owned joins should stay plain",
    );
  });

  it("does not whole-wrap direct reactive map roots inside callback-local JSX", async () => {
    const output = await transformSource(
      NESTED_REACTIVE_ROOT_MAP_SOURCE,
      {
        types: { "commontools.d.ts": commontools },
      },
    );
    const normalized = output.replace(/\s+/g, " ");

    assertStringIncludes(output, 'section.key("tasks").mapWithPattern(');
    assert(
      !normalized.includes(
        '({ section, task, taskIndex, tag, tagIndex, state }) => section.key("tasks").mapWithPattern(',
      ),
      "direct reactive callback-root maps should stay structural mapWithPattern roots, not whole-root derive wrappers",
    );
  });

  it("does not capture nested plain-array callback locals in parking-style join branches", async () => {
    const output = await transformSource(
      PARKING_STYLE_JOIN_SOURCE,
      {
        types: { "commontools.d.ts": commontools },
      },
    );
    const normalized = output.replace(/\s+/g, " ");

    assertStringIncludes(
      normalized,
      'spotPreferences.map((n) => "#" + n).join(", ")',
    );
    assert(
      !normalized.includes("{ n: n }"),
      "parking-style join branches should not capture nested plain-array callback locals",
    );
  });

  it("rewrites dynamic checkbox bindings inside plain array callbacks without claiming the callback root", async () => {
    const output = await transformSource(
      GOOGLE_SCOPE_CHECKBOX_SOURCE,
      {
        types: { "commontools.d.ts": commontools },
      },
    );
    const normalized = output.replace(/\s+/g, " ");

    assertStringIncludes(
      normalized,
      "Object.entries(SCOPE_DESCRIPTIONS).map(([key, description]) => (",
    );
    assertStringIncludes(
      normalized,
      "selectedScopes: selectedScopes, key: key",
    );
    assertStringIncludes(
      normalized,
      "({ selectedScopes, key }) => selectedScopes[key as keyof SelectedScopes]",
    );
    assert(
      !normalized.includes(
        "({ selectedScopes, key, description }) => Object.entries(SCOPE_DESCRIPTIONS).map(",
      ),
      "plain array callback roots should stay plain .map() calls while the dynamic checkbox binding is derived",
    );
  });

  it("rewrites arithmetic JSX bindings inside plain array callbacks without claiming the callback root", async () => {
    const output = await transformSource(
      `/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  multiplier: number;
}

export default pattern<State>((state) => {
  const plainArray = [1, 2, 3];

  return {
    [UI]: (
      <div>
        {plainArray.map((n) => (
          <span>{n * state.multiplier}</span>
        ))}
      </div>
    ),
  };
});
`,
      {
        types: { "commontools.d.ts": commontools },
      },
    );
    const normalized = output.replace(/\s+/g, " ");

    assertStringIncludes(
      normalized,
      "plainArray.map((n) => (<span>{__ctHelpers.derive(",
    );
    assertStringIncludes(
      normalized,
      "state: { multiplier: state.multiplier }",
    );
    assertStringIncludes(
      normalized,
      "({ state }) => n * state.multiplier",
    );
    assert(
      !normalized.includes(".mapWithPattern("),
      "plain array callback roots should stay plain .map() calls while the JSX-local arithmetic binding is derived",
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
});
