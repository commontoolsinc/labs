import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { transformSource } from "./utils.ts";

Deno.test(
  "Transform guards: nested block shadowing does not leak opaque alias roots",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commonfabric";
const p = pattern((input: { user: { name: string }; value: { foo: number } }) => {
  const value = { foo: 1 };
  {
    const value = input.user;
    void value.name;
  }
  return <div>{value.foo}</div>;
});
`;

    const output = await transformSource(source);

    assertStringIncludes(output, 'const value = input.key("user");');
    assertStringIncludes(output, "return <div>{value.foo}</div>;");
    assert(!output.includes('value.key("foo")'));
  },
);

Deno.test(
  "Transform guards: plain callback parameter map is not rewritten in pattern",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commonfabric";
const p = pattern((input: { ok: boolean }) => {
  const out = ((arr: number[]) => arr.map((x) => x + 1))([1, 2]);
  return <div>{out.length}</div>;
});
`;

    const output = await transformSource(source);

    assertStringIncludes(output, "arr.map((x) => x + 1)");
    assert(!output.includes(".mapWithPattern("));
  },
);

Deno.test(
  "Transform guards: rewritten mapWithPattern callback uses key(...) canonicalization",
  async () => {
    const source = `/// <cts-enable />
import { pattern, derive } from "commonfabric";
const p = pattern((input: { list: Array<{ name: string; age: number }> }) => <div>{derive(input.list, (v) => v).map(({ name }) => <span>{name}</span>)}</div>);
`;

    const output = await transformSource(source);

    assertStringIncludes(output, ".mapWithPattern(");
    assertStringIncludes(
      output,
      'const name = __ct_pattern_input.key("element", "name");',
    );
  },
);

Deno.test(
  "Transform guards: state property names that collide with method names still lower to key() access",
  async () => {
    for (
      const { property, extraAssert } of [
        {
          property: "filter",
          extraAssert: (output: string) =>
            assert(!output.includes("filterWithPattern")),
        },
        { property: "map", extraAssert: (_output: string) => {} },
        { property: "set", extraAssert: (_output: string) => {} },
      ]
    ) {
      const source = `/// <cts-enable />
import { pattern, UI } from "commonfabric";
interface State { ${property}: string; items?: string[] }
const p = pattern<State>((state) => ({
  [UI]: <div>{state.${property}}</div>,
}));
`;
      const output = await transformSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertStringIncludes(output, `state.key("${property}")`);
      extraAssert(output);
    }
  },
);

Deno.test(
  "Transform guards: unsupported reactive array find() does not lower to findWithPattern",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commonfabric";
interface Item { id: number; name: string }
interface State { items: Item[] }
const p = pattern<State>((state) => ({
  [UI]: <div>{state.items.find((item) => item.id === 1)?.name}</div>,
}));
`;

    const output = await transformSource(source, { types: COMMONFABRIC_TYPES });

    assert(!output.includes("findWithPattern"));
  },
);

Deno.test(
  "Transform guards: aliased get-result callbacks inside computed stay plain",
  async () => {
    const source = `/// <cts-enable />
import { computed, pattern, UI } from "commonfabric";

interface Habit {
  name: string;
}

interface HabitLog {
  habitName: string;
  date: string;
  completed: boolean;
}

interface Input {
  habits: Habit[];
  logs: HabitLog[];
  todayDate: string;
}

export default pattern<Input>(({ habits, logs, todayDate }) => {
  return {
    [UI]: <div>{habits.map((habit) => {
      const doneToday = computed(() => {
        const logList = logs.get();
        return logList.some(
          (log) =>
            log.habitName === habit.name &&
            log.date === todayDate &&
            log.completed,
        );
      });
      return <span>{doneToday ? "yes" : "no"}</span>;
    })}</div>,
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(output, "const logList = logs.get();");
    assertStringIncludes(
      output,
      "return logList.some((log) => log.habitName === habit.name &&",
    );
    assert(
      !output.includes("return logList.some((log) => __cfHelpers.when("),
      "aliased plain array some() callback should stay plain inside computed()/derive()",
    );
  },
);

Deno.test(
  "Transform guards: ternary branch derive absorbs inner arithmetic instead of nesting",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commonfabric";

interface Item {
  id: number;
  price: number;
}

interface State {
  items: Item[];
  discount: number;
  threshold: number;
}

export default pattern<State>((state) => ({
  [UI]: (
    <div>
      {state.items.map((item) => (
        <div>
          {item.price > state.threshold
            ? item.price * (1 - state.discount)
            : item.price}
        </div>
      ))}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertEquals(output.match(/__cfHelpers\.derive\(/g)?.length ?? 0, 2);
    assertStringIncludes(output, "item.price * (1 - state.discount)");
    assert(
      !output.includes("item.price * (__cfHelpers.derive("),
      "expected ternary branch derive to absorb inner arithmetic instead of nesting a second derive",
    );
  },
);

Deno.test(
  "Transform guards: ifElse predicate binary is not treated as a pattern-owned branch",
  async () => {
    const source = `/// <cts-enable />
import { ifElse, pattern, UI } from "commonfabric";

interface Field {
  name: string;
  validationIssue?: { message: string };
}

export default pattern<{ fields: Field[] }>((state) => ({
  [UI]: (
    <div>
      {state.fields.map((field) => (
        <div>
          {ifElse(
            field.validationIssue !== undefined,
            <span>{field.validationIssue?.message}</span>,
            null,
          )}
        </div>
      ))}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(output, "ifElse(");
    assertStringIncludes(output, "=> field.validationIssue !== undefined");
  },
);

Deno.test(
  "Transform guards: helper-owned non-cell get() calls are not force-wrapped",
  async () => {
    const source = `/// <cts-enable />
import { ifElse, pattern, UI } from "commonfabric";

interface State {
  show: boolean;
  selected: string;
}

class Lookup {
  get(key: string): string | undefined {
    return key.toUpperCase();
  }
}

export default pattern<State>((state) => {
  const lookup = new Lookup();
  return {
    [UI]: <div>{ifElse(state.show, lookup.get(state.selected), "missing")}</div>,
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(output, "lookup.get(");
    assert(
      !/__cfHelpers\.(?:computed|derive)\([\s\S]{0,160}lookup\.get\(/.test(
        output,
      ),
      "expected non-cell helper-owned get() calls to remain plain method calls",
    );
  },
);

Deno.test(
  "Transform guards: helper-owned child key references stay structural",
  async () => {
    const source = `/// <cts-enable />
import { Cell, Default, handler, lift, pattern, Stream } from "commonfabric";

const childIncrement = handler(
  (event: { amount?: number } | undefined, context: { value: Cell<number> }) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    context.value.set((context.value.get() ?? 0) + amount);
  },
);

const forward = handler(
  (_event: unknown, context: { increment: Stream<{ amount?: number }> }) => {
    context.increment.send({ amount: 1 });
  },
);

const childCounter = pattern<{ value: Default<number, 0> }>(({ value }) => ({
  value,
  increment: childIncrement({ value }),
}));

const sum = lift((input: { left: number; right: number }) => input.left + input.right);

export default pattern<{ left: Default<number, 0>; right: Default<number, 0> }>(
  ({ left, right }) => {
    const leftChild = childCounter({ value: left });
    const rightChild = childCounter({ value: right });

    return {
      total: sum({
        left: leftChild.key("value"),
        right: rightChild.key("value"),
      }),
      forward: forward({ increment: rightChild.key("increment") }),
    };
  },
);
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(output, 'left: leftChild.key("value")');
    assertStringIncludes(output, 'right: rightChild.key("value")');
    assertStringIncludes(output, 'increment: rightChild.key("increment")');
    assert(
      !output.includes(
        '__cfHelpers.computed((): any => leftChild.key("value"))',
      ),
      "expected child value cell reference to stay structural inside helper-owned arguments",
    );
    assert(
      !output.includes(
        '__cfHelpers.computed((): any => rightChild.key("increment"))',
      ),
      "expected child stream reference to stay structural inside helper-owned arguments",
    );
  },
);

Deno.test(
  "Transform guards: ordinary helper calls with child key references stay structural",
  async () => {
    const source = `/// <cts-enable />
import { Cell, Default, handler, pattern, type Stream } from "commonfabric";

const asIncrementStream = (
  ref: unknown,
): Stream<{ amount?: number }> => ref as Stream<{ amount?: number }>;

const childIncrement = handler(
  (_event: { amount?: number } | undefined, _context: { value: Cell<number> }) => {},
);

const bubbleToChild = handler(
  (_event: unknown, context: { childIncrement: Stream<{ amount?: number }> }) => {
    context.childIncrement.send({ amount: 1 });
  },
);

const childCounter = pattern<{ value: Default<number, 0> }>(({ value }) => ({
  value,
  increment: childIncrement({ value }),
}));

export default pattern<{ child: Default<number, 0> }>(({ child }) => {
  const childState = childCounter({ value: child });
  return {
    bubbleToChild: bubbleToChild({
      childIncrement: asIncrementStream(childState.key("increment")),
    }),
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(
      output,
      'childIncrement: asIncrementStream(childState.key("increment"))',
    );
    assert(
      !/__cfHelpers\.(?:computed|derive)\([\s\S]{0,240}asIncrementStream\(childState\.key\("increment"\)\)/
        .test(
          output,
        ),
      "expected child stream key reference to stay structural inside ordinary helper call arguments",
    );
  },
);
