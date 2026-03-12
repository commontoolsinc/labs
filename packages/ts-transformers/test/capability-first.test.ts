import {
  assert,
  assertEquals,
  assertGreater,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { transformSource, validateSource } from "./utils.ts";
import { COMMONTOOLS_TYPES } from "./commontools-test-types.ts";

Deno.test("Capability-first: pattern JSX lowers && with when()", async () => {
  const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern(({ foo, user: { name } }) => <div>{foo && name}</div>);
`;

  const output = await transformSource(source);

  assertStringIncludes(output, "__ctHelpers.when(");
  assert(!output.includes("{foo && name}"));
  assertStringIncludes(output, 'const foo = __ct_pattern_input.key("foo");');
  assertStringIncludes(
    output,
    'const name = __ct_pattern_input.key("user", "name");',
  );
});

Deno.test("Capability-first: compute JSX keeps authored &&", async () => {
  const source = `/// <cts-enable />
import { pattern, computed } from "commontools";
const p = pattern(({ foo, bar }) => <div>{computed(() => foo && bar)}</div>);
`;

  const output = await transformSource(source);

  assertStringIncludes(output, "=> foo && bar");
  assert(!output.includes("__ctHelpers.when("));
});

Deno.test(
  "Capability-first: map in compute context from JSX wrapper does not rewrite",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern(({ list }: { list: string[] }) => <div>{[0, 1].forEach(() => list.map((item) => item))}</div>);
`;

    const output = await transformSource(source);

    assertStringIncludes(output, "list.map((item) => item)");
    assert(!output.includes(".mapWithPattern("));
  },
);

Deno.test(
  "Capability-first: direct computed result map inside computed stays plain",
  async () => {
    const source = `/// <cts-enable />
import { computed, pattern } from "commontools";
const p = pattern<{ items: string[] }>((state) => {
  const inner = computed(() => state.items);
  return computed(() => inner.map((item) => item.toUpperCase()));
});
`;

    const output = await transformSource(source);

    assertStringIncludes(output, "=> inner.map((item) => item.toUpperCase())");
    assert(!output.includes("inner.mapWithPattern("));
  },
);

Deno.test(
  "Capability-first: direct pattern property access map inside computed stays plain",
  async () => {
    const source = `/// <cts-enable />
import { computed, pattern } from "commontools";
const p = pattern<{ items: string[] }>((state) =>
  computed(() => state.items.map((item) => item.toUpperCase()))
);
`;

    const output = await transformSource(source);

    assertStringIncludes(
      output,
      "=> state.items.map((item) => item.toUpperCase())",
    );
    assert(!output.includes("state.items.mapWithPattern("));
  },
);

Deno.test(
  "Capability-first: direct derive callback parameter map stays plain",
  async () => {
    const source = `/// <cts-enable />
import { derive, pattern } from "commontools";
const p = pattern<{ items: string[] }>((state) =>
  derive({ items: state.items }, ({ items }) => items.map((item) => item.toUpperCase()))
);
`;

    const output = await transformSource(source);

    assertStringIncludes(
      output,
      "({ items }) => items.map((item) => item.toUpperCase())",
    );
    assert(!output.includes("items.mapWithPattern("));
  },
);

Deno.test(
  "Capability-first: local computed alias inside computed regains mapWithPattern",
  async () => {
    const source = `/// <cts-enable />
import { computed, pattern } from "commontools";
const p = pattern<{ items: string[] }>((state) => {
  const inner = computed(() => state.items);
  return computed(() => {
    const foo = computed(() => inner);
    return foo.map((item) => item.toUpperCase());
  });
});
`;

    const output = await transformSource(source);

    assertStringIncludes(output, "foo.mapWithPattern(");
    assert(!output.includes("return foo.map((item) => item.toUpperCase())"));
  },
);

Deno.test(
  "Capability-first: local lifted alias inside computed regains mapWithPattern",
  async () => {
    const source = `/// <cts-enable />
import { computed, lift, pattern } from "commontools";
const passthrough = lift((items: string[]) => items);
const p = pattern<{ items: string[] }>((state) => {
  const inner = computed(() => state.items);
  return computed(() => {
    const foo = passthrough(inner);
    return foo.map((item) => item.toUpperCase());
  });
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "foo.mapWithPattern(");
    assert(!output.includes("return foo.map((item) => item.toUpperCase())"));
  },
);

Deno.test(
  "Capability-first: local wish result alias inside computed regains mapWithPattern",
  async () => {
    const source = `/// <cts-enable />
import { computed, Default, pattern, wish } from "commontools";
const p = pattern<Record<string, never>>(() => {
  return computed(() => {
    const foo = wish<Default<string[], []>>({ query: "#items" }).result!;
    return foo.map((item) => item.toUpperCase());
  });
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "foo.mapWithPattern(");
    assert(!output.includes("return foo.map((item) => item.toUpperCase())"));
  },
);

Deno.test(
  "Capability-first: transformed filter output alias inside computed regains mapWithPattern",
  async () => {
    const source = `/// <cts-enable />
import { computed, pattern } from "commontools";
const p = pattern<{ items: string[] }>((state) => {
  const inner = computed(() => state.items);
  return computed(() => {
    const foo = computed(() => inner);
    const filtered = foo.filter((item) => item.length > 1);
    return filtered.map((item) => item.toUpperCase());
  });
});
`;

    const output = await transformSource(source);

    assertStringIncludes(output, "foo.filterWithPattern(");
    assertStringIncludes(output, "filtered.mapWithPattern(");
    assert(
      !output.includes("return filtered.map((item) => item.toUpperCase())"),
    );
  },
);

Deno.test(
  "Capability-first: nested block shadowing does not leak opaque alias roots",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
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
  "Capability-first: plain callback parameter map is not rewritten in pattern",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
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
  "Capability-first: pattern JSX map still rewrites after prior JSX lowering",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  items: Array<{ price: number }>;
  discount: number;
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>{item.price * state.discount}</span>
        ))}
      </div>
    ),
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, ".mapWithPattern(");
    assert(!output.includes("state.items.map((item) =>"));
  },
);

Deno.test(
  "Capability-first: JSX map/filter chain keeps filter callback in compute context",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";

interface Item {
  name: string;
  active: boolean;
}

const p = pattern<{ list: Item[] }>(({ list }) => (
  <div>
    {list
      .map((item) => ({
        name: item.name,
        active: item.active,
      }))
      .filter((entry) => entry.active)
      .map((entry) => <span>{entry.name}</span>)}
  </div>
));
`;

    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    const creationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:function-creation"
    );
    assertEquals(creationDiagnostics.length, 0);
    // With filter/flatMap generalization, .filter() on reactive arrays
    // is now transformed to .filterWithPattern()
    assertStringIncludes(output, "filterWithPattern");
  },
);

Deno.test(
  "Capability-first: rewritten mapWithPattern callback uses key(...) canonicalization",
  async () => {
    const source = `/// <cts-enable />
import { pattern, derive } from "commontools";
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
  "Capability-first diagnostics: rest destructuring is non-lowerable",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern(({ foo, ...rest }) => <div>{foo}</div>);
`;

    const { diagnostics } = await validateSource(source);
    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assertEquals(computationDiagnostics.length, 1);
    assertStringIncludes(
      computationDiagnostics[0]!.message,
      "Rest destructuring",
    );
  },
);

Deno.test(
  "Capability-first diagnostics: array destructuring is lowerable",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern(([first]) => <div>{first}</div>);
`;

    const { diagnostics } = await validateSource(source);
    const output = await transformSource(source);
    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assertEquals(computationDiagnostics.length, 0);
    assertStringIncludes(output, 'const first = __ct_pattern_input.key("0");');
  },
);

Deno.test(
  "Capability-first: static default initializer destructuring lowers to schema default",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern<{ foo: string }>(({ foo = "fallback" }) => <div>{foo}</div>);
`;

    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assertEquals(computationDiagnostics.length, 0);
    assertStringIncludes(
      output,
      '"default": "fallback"',
    );
  },
);

Deno.test(
  "Capability-first: static default initializer extraction works with interface input types",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
interface Input {
  foo: string;
  count: number;
}
const p = pattern<Input>(({ foo = "fallback", count = 0 }) => <div>{foo}:{count}</div>);
`;

    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assertEquals(computationDiagnostics.length, 0);
    assertStringIncludes(output, '"default": "fallback"');
    assertStringIncludes(output, '"default": 0');
  },
);

Deno.test(
  "Capability-first: interface defaults keep non-default sibling fields in pattern input schema",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
interface Input {
  foo: string;
  count: number;
  enabled: boolean;
}
const p = pattern<Input>(({ foo = "fallback", count = 0 }) => <div>{foo}:{count}</div>);
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, '"default": "fallback"');
    assertStringIncludes(output, '"default": 0');
    assertStringIncludes(output, '"enabled"');
  },
);

Deno.test(
  "Capability-first diagnostics: non-static default initializer destructuring is non-lowerable",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const fallback = "fallback";
const p = pattern(({ foo = fallback }) => <div>{foo}</div>);
`;

    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assertEquals(computationDiagnostics.length, 1);
    assertStringIncludes(
      computationDiagnostics[0]!.message,
      "Non-static destructuring initializers",
    );
  },
);

Deno.test(
  "Capability-first diagnostics: computed binding key destructuring is lowerable",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const key = "foo" as const;
const p = pattern(({ [key]: foo }) => <div>{foo}</div>);
`;

    const { diagnostics } = await validateSource(source);
    const output = await transformSource(source);
    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assertEquals(computationDiagnostics.length, 0);
    assertStringIncludes(output, "const foo = __ct_pattern_input.key(key);");
  },
);

Deno.test(
  "Capability-first: computed literal member defaults are preserved in schema",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern<{ ["foo"]: string; bar: string }>(({ ["foo"]: foo = "fallback" }) => <div>{foo}</div>);
`;

    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assertEquals(computationDiagnostics.length, 0);
    assertStringIncludes(output, '"default": "fallback"');
  },
);

Deno.test(
  "Capability-first: mapWithPattern array destructuring lowers to key bindings",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commontools";
type Row = [left: string, right: string];
interface State {
  rows: Row[];
}
const p = pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.rows.map(([left, right]) => <span>{left}:{right}</span>)}
      </div>
    ),
  };
});
`;

    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assertEquals(computationDiagnostics.length, 0);
    assertStringIncludes(
      output,
      'const left = __ct_pattern_input.key("element", "0");',
    );
    assertStringIncludes(
      output,
      'const right = __ct_pattern_input.key("element", "1");',
    );
    assertStringIncludes(output, ".mapWithPattern(");
  },
);

Deno.test(
  "Capability-first diagnostics: optional-call stays blocked in pattern context",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern((input) => input?.foo());
`;

    const { diagnostics } = await validateSource(source);

    const optionalDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:optional-chaining"
    );

    assert(optionalDiagnostics.length >= 1);
    assertStringIncludes(optionalDiagnostics[0]!.message, "Optional chaining");
  },
);

Deno.test(
  "Capability-first diagnostics: builder placement remains enforced",
  async () => {
    const source = `/// <cts-enable />
import { pattern, lift } from "commontools";
const p = pattern((input) => {
  const inc = lift((value: number) => value + 1);
  return inc(input.foo);
});
`;

    const { diagnostics } = await validateSource(source);

    const builderDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:builder-placement"
    );
    assertEquals(builderDiagnostics.length, 1);
    assertStringIncludes(builderDiagnostics[0]!.message, "module scope");
  },
);

Deno.test(
  "Capability-first diagnostics: restricted .get() keeps pattern-context:get-call",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern((input) => input.get());
`;

    const { diagnostics } = await validateSource(source);

    const getDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:get-call"
    );
    assertEquals(getDiagnostics.length, 1);
  },
);

Deno.test(
  "Capability-first diagnostics: standalone reactive operation codes remain stable",
  async () => {
    const source = `/// <cts-enable />
import { computed, pattern } from "commontools";
const helper = ({ value }: { value: number }) => computed(() => value + 1);
const p = pattern((input) => input.foo);
`;

    const { diagnostics } = await validateSource(source);

    const standaloneDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "standalone-function:reactive-operation"
    );
    assertEquals(standaloneDiagnostics.length, 1);
    assertStringIncludes(standaloneDiagnostics[0]!.message, "standalone");
  },
);

Deno.test(
  "Capability-first: explicit Writable input keeps wrapped object schema in lift",
  async () => {
    const source = `/// <cts-enable />
import { lift, type Writable } from "commontools";
const fn = lift((input: Writable<{ foo: string; bar: string }>) => input.get().foo);
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
  },
);

Deno.test(
  "Capability-first: pattern input preserves full shape for downstream continuity",
  async () => {
    const source = `/// <cts-enable />
import { pattern, type Writable } from "commontools";
const p = pattern((input: Writable<{ foo: string; bar: string }>) => input.key("foo").get());
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asOpaque: true");
    assertStringIncludes(output, '"foo"');
    assertStringIncludes(output, '"bar"');
  },
);

Deno.test(
  "Capability-first: shrunk undefined-union field stays optional in schema",
  async () => {
    const source = `/// <cts-enable />
import { lift, type Writable } from "commontools";
const fn = lift((input: Writable<{ foo: string | undefined; bar: string }>) =>
  input.key("foo").get()
);
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assert(!output.includes('"bar"'));
    assert(!output.includes('required: ["foo"]'));
  },
);

Deno.test(
  "Capability-first: pattern explicit type arguments preserve full input shape",
  async () => {
    const source = `/// <cts-enable />
import { pattern, type Writable } from "commontools";
const p = pattern<Writable<{ foo: string; bar: string }>, { foo: string }>((input) => ({
  foo: input.key("foo").get(),
}));
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asOpaque: true");
    assertStringIncludes(output, '"foo"');
    assertStringIncludes(output, '"bar"');
  },
);

Deno.test(
  "Capability-first: derive input shrinks to observed key paths",
  async () => {
    const source = `/// <cts-enable />
import { derive, type Writable } from "commontools";
const state = {} as Writable<{ foo: string; bar: string }>;
const d = derive(state, (input: Writable<{ foo: string; bar: string }>) => input.key("foo").get());
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assert(!output.includes('"bar"'));
  },
);

Deno.test(
  "Capability-first: derive explicit type arguments still shrink input paths",
  async () => {
    const source = `/// <cts-enable />
import { derive, type Writable } from "commontools";
const input = {} as Writable<{ foo: string; bar: string }>;
const d = derive<Writable<{ foo: string; bar: string }>, string>(
  input,
  (value) => value.key("foo").get(),
);
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assert(!output.includes('"bar"'));
  },
);

Deno.test(
  "Capability-first: handler state shrinks to observed key paths",
  async () => {
    const source = `/// <cts-enable />
import { handler, type Writable } from "commontools";
const h = handler((event: { id: string }, state: Writable<{ foo: string; bar: string }>) => {
  state.key("foo").get();
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assert(!output.includes('"bar"'));
  },
);

Deno.test(
  "Capability-first: handler explicit type arguments shrink event and state paths",
  async () => {
    const source = `/// <cts-enable />
import { handler, type Writable } from "commontools";
const h = handler<
  { detail: { message: string; unused: number } },
  Writable<{ foo: string; bar: string }>
>((event, state) => {
  event.detail.message;
  state.key("foo").get();
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, '"message"');
    assert(!output.includes('"unused"'));
    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assert(!output.includes('"bar"'));
  },
);

Deno.test(
  "Capability-first: lift passthrough degrades wrapped input to opaque capability",
  async () => {
    const source = `/// <cts-enable />
import { lift, type Writable } from "commontools";
const fn = lift((input: Writable<{ foo: string; bar: string }>) => input);
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asOpaque: true");
    assertStringIncludes(output, '"foo"');
    assertStringIncludes(output, '"bar"');
  },
);

Deno.test(
  "Capability-first: compute callback inherits callee read paths interprocedurally",
  async () => {
    const source = `/// <cts-enable />
import { lift, type Writable } from "commontools";

const helper = (value: Writable<{ foo: string; bar: string }>) =>
  value.key("foo").get();

const fn = lift((input: Writable<{ foo: string; bar: string }>) => helper(input));
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assert(!output.includes('"bar"'));
    assert(!output.includes("asOpaque: true"));
  },
);

Deno.test(
  "Capability-first: pattern callback keeps direct local signature semantics",
  async () => {
    const source = `/// <cts-enable />
import { pattern, type Writable } from "commontools";

const helper = (value: Writable<{ foo: string; bar: string }>) =>
  value.key("foo").get();

const p = pattern((input: Writable<{ foo: string; bar: string }>) => helper(input));
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asOpaque: true");
    assertStringIncludes(output, '"foo"');
    assertStringIncludes(output, '"bar"');
  },
);

Deno.test(
  "Capability-first: lift write-only usage shrinks wrapped input paths",
  async () => {
    const source = `/// <cts-enable />
import { lift, type Writable } from "commontools";
const fn = lift((input: Writable<{ foo: string; bar: string }>) => {
  input.key("foo").set("updated");
  return 1;
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assert(!output.includes('"bar"'));
  },
);

Deno.test(
  "Capability-first: lift explicit type arguments still shrink input paths",
  async () => {
    const source = `/// <cts-enable />
import { lift, type Writable } from "commontools";
const fn = lift<Writable<{ foo: string; bar: string }>, string>(
  (input) => input.key("foo").get(),
);
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assert(!output.includes('"bar"'));
  },
);

Deno.test(
  "Capability-first: action state shrinks to observed key paths",
  async () => {
    const source = `/// <cts-enable />
import { action, pattern, type Writable } from "commontools";
const p = pattern((input: Writable<{ foo: string; bar: string }>) => {
  const a = action(() => input.key("foo").get());
  return a;
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asOpaque: true");
    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assertStringIncludes(output, 'required: ["foo"]');
  },
);

Deno.test(
  "Capability-first diagnostics: pattern spread traversal emits computation code",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern((input) => ({ ...input }));
`;

    const { diagnostics } = await validateSource(source);
    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assert(computationDiagnostics.length >= 1);
  },
);

Deno.test(
  "Capability-first diagnostics: pattern Object.keys/values/entries emit computation code",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern((input) => {
  Object.keys(input);
  Object.values(input);
  Object.entries(input);
  return input;
});
`;

    const { diagnostics } = await validateSource(source);
    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assert(computationDiagnostics.length >= 3);
  },
);

Deno.test(
  "Capability-first diagnostics: pattern dynamic key access emits computation code",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern((input, key: string) => input[key]);
`;

    const { diagnostics } = await validateSource(source);
    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assert(computationDiagnostics.length >= 1);
  },
);

Deno.test(
  "Capability-first diagnostics: known symbol key access is lowerable",
  async () => {
    const source = `/// <cts-enable />
import { NAME, UI, pattern } from "commontools";
const p = pattern(({ items }) => items.map((item) => ({ n: item[NAME], u: item[UI] })));
`;

    const { diagnostics } = await validateSource(source);
    const output = await transformSource(source);

    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assertEquals(computationDiagnostics.length, 0);
    assertStringIncludes(output, "item.key(__ctHelpers.NAME)");
    assertStringIncludes(output, "item.key(__ctHelpers.UI)");
  },
);

Deno.test(
  "Capability-first diagnostics: SELF destructuring key is lowerable",
  async () => {
    const source = `/// <cts-enable />
import { SELF, pattern } from "commontools";
const p = pattern(({ [SELF]: self, value }) => self);
`;

    const { diagnostics } = await validateSource(source);
    const output = await transformSource(source);

    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assertEquals(computationDiagnostics.length, 0);
    assertStringIncludes(
      output,
      "const self = __ct_pattern_input[__ctHelpers.SELF];",
    );
    assertStringIncludes(
      output,
      'const value = __ct_pattern_input.key("value");',
    );
  },
);

Deno.test(
  "Capability-first: map callback receiver path lowers before mapWithPattern terminal",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern(({ items }) =>
  items.map((item) => item.subItems.map((subItem) => subItem.value))
);
`;

    const output = await transformSource(source);

    assertStringIncludes(output, 'item.key("subItems").mapWithPattern(');
    assertStringIncludes(output, 'return subItem.key("value");');
  },
);

Deno.test(
  "Capability-first diagnostics: pattern for..in emits computation code",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern((input) => {
  for (const key in input) {
    key;
  }
  return input;
});
`;

    const { diagnostics } = await validateSource(source);
    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assert(computationDiagnostics.length >= 1);
  },
);

Deno.test(
  "Capability-first diagnostics: pattern JSON.stringify emits computation code",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern((input) => JSON.stringify(input));
`;

    const { diagnostics } = await validateSource(source);
    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assert(computationDiagnostics.length >= 1);
  },
);

Deno.test(
  "Capability-first: compute wildcard usage keeps conservative full-shape input schema",
  async () => {
    const source = `/// <cts-enable />
import { lift, type Writable } from "commontools";
const fn = lift((input: Writable<{ foo: string; bar: string }>) => {
  const foo = input.key("foo").get();
  Object.keys(input.get());
  return foo;
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assertStringIncludes(output, '"bar"');
  },
);

Deno.test(
  "Default mode uses capability-first diagnostics",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern((input) => input.get());
`;

    const defaultResult = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const explicitCapabilityResult = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    const toComparable = (
      diagnostics: readonly {
        type: string;
        severity: string;
        message: string;
      }[],
    ) =>
      diagnostics.map(({ type, severity, message }) => ({
        type,
        severity,
        message,
      }));

    assertEquals(
      toComparable(explicitCapabilityResult.diagnostics),
      toComparable(defaultResult.diagnostics),
    );
  },
);

Deno.test(
  "Capability-first: compute context rewrites map on Cell receiver",
  async () => {
    const source = `/// <cts-enable />
import { Cell, lift } from "commontools";
const items = Cell.of<string[]>([]);
const fn = lift(() => items.map((item) => item));
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, ".mapWithPattern(");
  },
);

Deno.test(
  "Capability-first: mapWithPattern callback schema omits params when unused",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commontools";

interface Item {
  id: string;
}

interface State {
  items: Item[];
}

export default pattern<State>((state) => {
  return {
    [UI]: <div>{state.items.map((item) => <span>{item.id}</span>)}</div>,
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, ".mapWithPattern(");
    assertStringIncludes(output, 'required: ["element"]');
    assert(!output.includes('required: ["element", "params"]'));
  },
);

Deno.test(
  "Capability-first: mapWithPattern callback schema includes params when captures are used",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commontools";

interface Item {
  price: number;
}

interface State {
  items: Item[];
  discount: number;
}

export default pattern<State>((state) => {
  return {
    [UI]: <div>{state.items.map((item) => <span>{item.price * state.discount}</span>)}</div>,
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, ".mapWithPattern(");
    assertStringIncludes(output, 'required: ["element", "params"]');
  },
);

Deno.test(
  "Capability-first: pattern context does not rewrite plain array map",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern(() => {
  const local = ["a", "b"];
  return local.map((item) => item);
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "local.map((item) => item)");
    assert(!output.includes(".mapWithPattern("));
  },
);

Deno.test(
  "Capability-first: rewrites map after computed fallback alias",
  async () => {
    const source = `/// <cts-enable />
import { computed, pattern, UI } from "commontools";

interface Reaction {
  emoji: string;
}

interface Message {
  id: string;
  reactions?: Reaction[];
}

interface Input {
  messages: Message[];
}

export default pattern<Input>(({ messages }) => {
  return {
    [UI]: (
      <div>
        {messages.map((msg) => {
          const messageReactions = computed(() => (msg.reactions) || []);
          return (
            <div>
              {messageReactions.map((reaction) => (
                <button data-msg-id={msg.id}>{reaction.emoji}</button>
              ))}
            </div>
          );
        })}
      </div>
    ),
  };
});
`;

    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    const fallbackDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:map-on-fallback"
    );

    assertEquals(fallbackDiagnostics.length, 0);
    assertStringIncludes(output, "messageReactions.mapWithPattern(");
    assertStringIncludes(output, 'data-msg-id={msg.key("id")}');
    assertStringIncludes(output, "reactions: {");
    assertStringIncludes(output, '$ref: "#/$defs/Reaction"');
    assert(!output.includes("reactions: true"));
    assert(!output.includes("element: true"));
  },
);

Deno.test(
  "Capability-first: rewrites inline reactive fallback map",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commontools";

interface Item {
  id: string;
}

export default pattern<{ items?: Item[] }>(({ items }) => {
  return {
    [UI]: (
      <div>
        {(items ?? []).map((item) => <span data-id={item.id}>{item.id}</span>)}
      </div>
    ),
  };
});
`;

    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    const fallbackDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:map-on-fallback"
    );

    assertGreater(fallbackDiagnostics.length, 0);
    assertStringIncludes(output, ".mapWithPattern(");
    assertStringIncludes(output, 'data-id={item.key("id")}');
  },
);

Deno.test(
  "Capability-first: rewrites cast-wrapped reactive fallback map",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commontools";

interface Item {
  id: string;
}

export default pattern<{ items?: Item[] }>(({ items }) => {
  return {
    [UI]: (
      <div>
        {((items as Item[] | undefined) ?? []).map((item) => (
          <span data-id={item.id}>{item.id}</span>
        ))}
      </div>
    ),
  };
});
`;

    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    const fallbackDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:map-on-fallback"
    );

    assertGreater(fallbackDiagnostics.length, 0);
    assertStringIncludes(output, ".mapWithPattern(");
    assertStringIncludes(output, 'data-id={item.key("id")}');
  },
);

Deno.test(
  "Capability-first: rewrites satisfies-wrapped reactive fallback map",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commontools";

interface Item {
  id: string;
}

export default pattern<{ items?: Item[] }>(({ items }) => {
  return {
    [UI]: (
      <div>
        {((items satisfies Item[] | undefined) ?? []).map((item) => (
          <span data-id={item.id}>{item.id}</span>
        ))}
      </div>
    ),
  };
});
`;

    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    const fallbackDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:map-on-fallback"
    );

    assertGreater(fallbackDiagnostics.length, 0);
    assertStringIncludes(output, ".mapWithPattern(");
    assertStringIncludes(output, 'data-id={item.key("id")}');
  },
);

Deno.test(
  "Capability-first: ternary lowered from key(...) keeps typed ifElse predicate schema",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commontools";

type State = {
  user: {
    settings: {
      notifications: boolean;
    };
  };
};

export default pattern<State>((state) => ({
  [UI]: (
    <div>
      {state.user.settings.notifications ? "enabled" : "disabled"}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assert(
      /__ctHelpers\.ifElse\(\{\s*type:\s*"boolean"/m.test(output),
      "expected ifElse condition schema to stay boolean after key(...) lowering",
    );
    assert(!output.includes("__ctHelpers.ifElse(true as const"));
  },
);

Deno.test(
  "Capability-first: ternary branch keeps pure JSX map in pattern context",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commontools";

interface TagEvent {
  label: string;
}

export default pattern<{ recentEvents: TagEvent[] }>(({ recentEvents }) => ({
  [UI]: (
    <div>
      {recentEvents.length === 0
        ? <span>No events yet</span>
        : (
          <div>
            {recentEvents.map((event: TagEvent, idx: number) => (
              <ct-hstack key={idx} gap="2">
                <span>{event.label}</span>
              </ct-hstack>
            ))}
          </div>
        )}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertEquals(
      output.match(/__ctHelpers\.derive\(/g)?.length ?? 0,
      1,
    );
    assertStringIncludes(
      output,
      "recentEvents.mapWithPattern(",
    );
    assert(
      !output.includes("recentEvents.map((event: TagEvent, idx: number) =>"),
      "expected pure JSX branch map to be rewritten to mapWithPattern without an extra derive branch",
    );
  },
);

Deno.test(
  "Capability-first: compute writable branch keeps nested maps in pattern callbacks",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI, Writable } from "commontools";

interface TagEvent {
  label: string;
  tags: string[];
}

export default pattern<{
  showEmpty: boolean;
  recentEvents: Writable<TagEvent[]>;
}>(({ showEmpty, recentEvents }) => ({
  [UI]: (
    <div>
      {showEmpty
        ? <span>No events yet</span>
        : recentEvents.get() && recentEvents.map((event: TagEvent) => (
          <ct-vstack>
            <span>{event.label}</span>
            {event.tags.map((tag: string) => <span>{tag}</span>)}
          </ct-vstack>
        ))}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertGreater(
      output.match(/__ctHelpers\.derive\(/g)?.length ?? 0,
      0,
    );
    assertStringIncludes(
      output,
      "recentEvents.get()",
    );
    assertStringIncludes(
      output,
      "recentEvents.mapWithPattern(",
    );
    assertStringIncludes(
      output,
      '.key("tags").mapWithPattern(',
    );
    assertEquals(
      output.match(/mapWithPattern\(/g)?.length ?? 0,
      2,
    );
    assert(
      !output.includes("recentEvents.map((event: TagEvent) =>"),
      "expected writable branch outer map to stay in pattern mode",
    );
    assert(
      !output.includes('.key("tags").map((tag: string) =>'),
      "expected writable branch nested map to stay in pattern mode",
    );
  },
);

Deno.test(
  "Capability-first: computed array map in ternary branch stays pattern",
  async () => {
    const source = `/// <cts-enable />
import { computed, pattern, UI, Writable } from "commontools";

interface Item {
  name: string;
  value: number;
}

export default pattern<{ items: Item[] }>((state) => {
  const showList = Writable.of(true);

  const sorted = computed(() =>
    [...state.items].sort((a, b) => a.value - b.value)
  );

  return {
    [UI]: (
      <div>
        {showList
          ? (
            <div>
              {sorted.map((item: Item) => (
                <span>{item.name}</span>
              ))}
            </div>
          )
          : <span>Hidden</span>}
      </div>
    ),
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertEquals(
      output.match(/__ctHelpers\.derive\(/g)?.length ?? 0,
      1,
    );
    assertStringIncludes(
      output,
      "sorted.mapWithPattern(",
    );
    assert(
      !output.includes("sorted.map((item: Item) =>"),
      "expected computed array map in ternary branch to stay pattern-lowered",
    );
  },
);

Deno.test(
  "Capability-first: ternary branch derive does not nest inner arithmetic derives",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commontools";

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
      types: COMMONTOOLS_TYPES,
    });

    assertEquals(
      output.match(/__ctHelpers\.derive\(/g)?.length ?? 0,
      2,
    );
    assertStringIncludes(
      output,
      "item.price * (1 - state.discount)",
    );
    assert(
      !output.includes("item.price * (__ctHelpers.derive("),
      "expected ternary branch derive to absorb inner arithmetic instead of nesting a second derive",
    );
  },
);

Deno.test(
  "Capability-first: ifElse predicate binary is not treated as a pattern-owned branch",
  async () => {
    const source = `/// <cts-enable />
import { ifElse, pattern, UI } from "commontools";

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
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "ifElse(");
    assertStringIncludes(
      output,
      "=> field.validationIssue !== undefined",
    );
  },
);

Deno.test(
  "Capability-first: nested authored ifElse predicate in helper-owned branch lowers to derive",
  async () => {
    const source = `/// <cts-enable />
import { computed, ifElse, pattern, UI } from "commontools";

interface ValidationIssue {
  message: string;
  severity: "error" | "warning";
}

interface ExtractedField {
  targetModule: string;
  fieldName: string;
  confidenceLevel?: "high" | "medium" | "low";
  validationIssue?: ValidationIssue;
  explanation?: string;
}

interface Preview {
  fields?: ExtractedField[];
}

export default pattern<{
  inputFields: ExtractedField[];
  fieldCheckStates: Record<string, boolean>;
  showPreview: boolean;
}>((state) => {
  const preview = computed((): Preview | null => ({ fields: state.inputFields }));

  return {
    [UI]: (
      <div>
        {ifElse(
          state.showPreview,
          <div>
            {preview?.fields?.map((f: ExtractedField, idx: number) => {
              const fieldKey = f.targetModule + "." + f.fieldName;
              const isChecked = state.fieldCheckStates[fieldKey] === true;
              const confidenceBg = f.confidenceLevel === "high"
                ? "#dcfce7"
                : f.confidenceLevel === "medium"
                ? "#fef9c3"
                : f.confidenceLevel === "low"
                ? "#fee2e2"
                : "transparent";
              const confidenceColor = f.confidenceLevel === "high"
                ? "#166534"
                : f.confidenceLevel === "medium"
                ? "#854d0e"
                : f.confidenceLevel === "low"
                ? "#991b1b"
                : "#6b7280";
              const confidenceIcon = f.confidenceLevel === "high"
                ? "✓"
                : f.confidenceLevel === "medium"
                ? "~"
                : f.confidenceLevel === "low"
                ? "!"
                : "";
              const confidenceLabel = f.confidenceLevel === "high"
                ? "High"
                : f.confidenceLevel === "medium"
                ? "Med"
                : f.confidenceLevel === "low"
                ? "Low"
                : "";
              const hasConfidence = f.confidenceLevel !== undefined;

              return (
                <div key={idx} style={{ opacity: isChecked ? 1 : 0.6 }}>
                  {ifElse(
                    hasConfidence,
                    <span style={{ background: confidenceBg, color: confidenceColor }}>
                      {confidenceIcon} {confidenceLabel}
                    </span>,
                    null,
                  )}
                  {ifElse(
                    f.validationIssue !== undefined,
                    <span
                      style={{
                        background: f.validationIssue?.severity === "error"
                          ? "#fee2e2"
                          : "#fef3c7",
                        color: f.validationIssue?.severity === "error"
                          ? "#991b1b"
                          : "#92400e",
                      }}
                    >
                      {f.validationIssue?.message}
                    </span>,
                    null,
                  )}
                  {ifElse(
                    f.explanation !== undefined && f.explanation !== "",
                    <div>{f.explanation}</div>,
                    null,
                  )}
                </div>
              );
            })}
          </div>,
          null,
        )}
      </div>
    ),
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(
      output,
      "=> f.validationIssue !== undefined",
    );
    assertMatch(
      output,
      /__ctHelpers\.derive\([\s\S]*validationIssue: f\.validationIssue[\s\S]*\(\{ f \}\) => f\.validationIssue !== undefined\)/,
    );
  },
);

Deno.test(
  "Capability-first: dynamic key access in helper-owned map callback initializer lowers without computation diagnostics",
  async () => {
    const source = `/// <cts-enable />
import { computed, ifElse, pattern, UI } from "commontools";

interface Field {
  targetModule: string;
  fieldName: string;
}

export default pattern<{
  inputFields: Field[];
  showPreview: boolean;
}>((state) => {
  const preview = computed(() => ({ fields: state.inputFields }));
  const fieldCheckStates = computed((): Record<string, boolean> => ({
    "record-title.name": true,
  }));

  return {
    [UI]: ifElse(
      state.showPreview,
      <div>
        {preview?.fields?.map((f: Field) => {
          const fieldKey = f.targetModule + "." + f.fieldName;
          const isChecked = fieldCheckStates[fieldKey] === true;
          return <span>{isChecked}</span>;
        })}
      </div>,
      null,
    ),
  };
});
`;

    const { diagnostics } = await validateSource(source, {
      mode: "error",
      types: COMMONTOOLS_TYPES,
    });
    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assertEquals(computationDiagnostics.length, 0);
    assertStringIncludes(output, ".mapWithPattern(");
    assertStringIncludes(output, "=> fieldCheckStates[fieldKey] === true");
    assert(
      !output.includes(
        "const isChecked = fieldCheckStates[fieldKey] === true;",
      ),
    );
  },
);

Deno.test(
  "Capability-first: computed array map preserves captures used in lowered control branches",
  async () => {
    const source = `/// <cts-enable />
import { computed, handler, ifElse, pattern, UI, Writable } from "commontools";

const openNoteEditor = handler<{
  subPieces: string[];
  editingNoteIndex: number | undefined;
  editingNoteText: string | undefined;
  index: number;
}>((_event, state) => state);
const openSettings = handler<{
  settingsModuleIndex: number | undefined;
  index: number;
}>((_event, state) => state);
const toggleExpanded = handler<{
  expandedIndex: number | undefined;
  index: number;
}>((_event, state) => state);
const trashSubPiece = handler<{
  subPieces: string[];
  trashedSubPieces: string[];
  expandedIndex: number | undefined;
  settingsModuleIndex: number | undefined;
  index: number;
}>((_event, state) => state);

interface Item {
  collapsed?: boolean;
  pinned?: boolean;
  allowMultiple: boolean;
}

export default pattern<{
  items: Item[];
  subPieces: string[];
  trashedSubPieces: string[];
}>(({ items, subPieces, trashedSubPieces }) => {
  const editingNoteIndex = Writable.of<number | undefined>();
  const editingNoteText = Writable.of<string | undefined>();
  const expandedIndex = Writable.of<number | undefined>();
  const settingsModuleIndex = Writable.of<number | undefined>();

  const allEntries = computed(() =>
    items.map((entry, index) => ({
      entry,
      index,
      isExpanded: index === 0,
      isPinned: entry.pinned || false,
      allowMultiple: entry.allowMultiple,
    }))
  );

  return {
    [UI]: (
      <div>
        {allEntries.map(({ entry, index, isExpanded, isPinned, allowMultiple }) =>
          ifElse(
            computed(() => !entry.collapsed),
            <div>
              {ifElse(
                allowMultiple,
                <button
                  onClick={openNoteEditor({
                    subPieces,
                    editingNoteIndex,
                    editingNoteText,
                    index,
                  })}
                >
                  note
                </button>,
                null,
              )}
              {!isExpanded && ifElse(
                true,
                <button
                  onClick={openSettings({ settingsModuleIndex, index })}
                >
                  settings
                </button>,
                null,
              )}
              <button
                onClick={toggleExpanded({ expandedIndex, index })}
                style={{ background: isPinned ? "a" : "b" }}
              >
                expand
              </button>
              {!isExpanded && (
                <button
                  onClick={trashSubPiece({
                    subPieces,
                    trashedSubPieces,
                    expandedIndex,
                    settingsModuleIndex,
                    index,
                  })}
                >
                  trash
                </button>
              )}
            </div>,
            null,
          )}
      </div>
    ),
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, ".mapWithPattern(");
    assertStringIncludes(
      output,
      'const subPieces = __ct_pattern_input.key("params", "subPieces");',
    );
    assertStringIncludes(
      output,
      'const editingNoteIndex = __ct_pattern_input.key("params", "editingNoteIndex");',
    );
    assertStringIncludes(
      output,
      'const editingNoteText = __ct_pattern_input.key("params", "editingNoteText");',
    );
    assertStringIncludes(
      output,
      'const settingsModuleIndex = __ct_pattern_input.key("params", "settingsModuleIndex");',
    );
    assertStringIncludes(
      output,
      'const expandedIndex = __ct_pattern_input.key("params", "expandedIndex");',
    );
    assertStringIncludes(
      output,
      'const trashedSubPieces = __ct_pattern_input.key("params", "trashedSubPieces");',
    );
  },
);

Deno.test(
  "Capability-first: computed array map preserves authored captures used by branch-lowered UI chunks",
  async () => {
    const source = `/// <cts-enable />
import { computed, handler, ifElse, pattern, UI, Writable } from "commontools";

const openNoteEditor = handler<{
  subPieces: string[];
  editingNoteIndex: number | undefined;
  editingNoteText: string;
  index: number;
}>((_event, state) => state);
const openSettings = handler<{
  settingsModuleIndex: number | undefined;
  index: number;
}>((_event, state) => state);
const toggleExpanded = handler<{
  expandedIndex: number | undefined;
  index: number;
}>((_event, state) => state);
const trashSubPiece = handler<{
  subPieces: string[];
  trashedSubPieces: string[];
  expandedIndex: number | undefined;
  settingsModuleIndex: number | undefined;
  index: number;
}>((_event, state) => state);

interface Item {
  note?: string;
  collapsed?: boolean;
  pinned?: boolean;
  allowMultiple: boolean;
}

export default pattern<{
  items: Item[];
  subPieces: string[];
  trashedSubPieces: string[];
}>(({ items, subPieces, trashedSubPieces }) => {
  const editingNoteIndex = Writable.of<number | undefined>();
  const editingNoteText = Writable.of("");
  const expandedIndex = Writable.of<number | undefined>();
  const settingsModuleIndex = Writable.of<number | undefined>();

  const allEntries = computed(() =>
    items.map((entry, index) => ({
      entry,
      index,
      isExpanded: index === 0,
      isPinned: entry.pinned || false,
      allowMultiple: entry.allowMultiple,
    }))
  );

  return {
    [UI]: (
      <div>
        {allEntries.map(({ entry, index, isExpanded, isPinned, allowMultiple }) =>
          ifElse(
            computed(() => !entry.collapsed),
            <div>
              {!isExpanded && (
                <button
                  onClick={openNoteEditor({
                    subPieces,
                    editingNoteIndex,
                    editingNoteText,
                    index,
                  })}
                  style={computed(() => ({
                    fontWeight: entry?.note ? "700" : "400",
                  }))}
                  title={computed(() => entry?.note || "Add note...")}
                >
                  note
                </button>
              )}
              {!isExpanded && ifElse(
                allowMultiple,
                <button
                  onClick={openSettings({ settingsModuleIndex, index })}
                >
                  settings
                </button>,
                null,
              )}
              <button
                onClick={toggleExpanded({ expandedIndex, index })}
                style={{ background: isPinned ? "a" : "b" }}
              >
                expand
              </button>
              {!isExpanded && (
                <button
                  onClick={trashSubPiece({
                    subPieces,
                    trashedSubPieces,
                    expandedIndex,
                    settingsModuleIndex,
                    index,
                  })}
                >
                  trash
                </button>
              )}
            </div>,
            null,
          )}
      </div>
    ),
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, ".mapWithPattern(");
    assertStringIncludes(
      output,
      'const subPieces = __ct_pattern_input.key("params", "subPieces");',
    );
    assertStringIncludes(
      output,
      'const editingNoteIndex = __ct_pattern_input.key("params", "editingNoteIndex");',
    );
    assertStringIncludes(
      output,
      'const editingNoteText = __ct_pattern_input.key("params", "editingNoteText");',
    );
    assertStringIncludes(
      output,
      'const settingsModuleIndex = __ct_pattern_input.key("params", "settingsModuleIndex");',
    );
    assertStringIncludes(
      output,
      'const expandedIndex = __ct_pattern_input.key("params", "expandedIndex");',
    );
    assertStringIncludes(
      output,
      'const trashedSubPieces = __ct_pattern_input.key("params", "trashedSubPieces");',
    );
  },
);

Deno.test(
  "Capability-first: self-improving classifier examples map keeps examples capture",
  async () => {
    const source = await Deno.readTextFile(
      new URL("../../patterns/self-improving-classifier.tsx", import.meta.url),
    );
    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    const mapStart = output.indexOf("{examples.mapWithPattern(");
    assert(
      mapStart >= 0,
      "expected transformed examples.mapWithPattern callback",
    );
    const mapWindow = output.slice(mapStart, mapStart + 5000);

    assertStringIncludes(
      mapWindow,
      'const selectedExampleId = __ct_pattern_input.key("params", "selectedExampleId");',
    );
    assertStringIncludes(
      mapWindow,
      'const currentItem = __ct_pattern_input.key("params", "currentItem");',
    );
    assertStringIncludes(
      mapWindow,
      'const examples = __ct_pattern_input.key("params", "examples");',
    );
  },
);

Deno.test(
  "Capability-first: shopping-list sorted ifElse branch does not wrap mapped results in derive",
  async () => {
    const source = await Deno.readTextFile(
      new URL("../../patterns/shopping-list.tsx", import.meta.url),
    );
    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "itemsWithAisles.mapWithPattern(");
    assert(
      !output.includes(
        'required: ["itemsWithAisles", "items", "correctionIndex", "correctionTitle", "hasConnectedStore"]',
      ),
      "expected shopping-list sorted branch to stay pattern-lowered instead of wrapping the whole branch in derive",
    );
  },
);

Deno.test(
  "Capability-first: authored ifElse rewrites condition and branches uniformly",
  async () => {
    const source = `/// <cts-enable />
import { ifElse, pattern, UI } from "commontools";

interface Item {
  name: string;
}

export default pattern<{ items: Item[]; limit: number }>(({ items, limit }) => ({
  [UI]: (
    <div>
      {ifElse(
        limit > 0,
        items.map((item: Item) => <span>{item.name}</span>),
        <span>Hidden</span>,
      )}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(
      output,
      "=> limit > 0",
    );
    assertStringIncludes(
      output,
      "items.mapWithPattern(",
    );
    assert(
      !output.includes("items.map((item: Item) =>"),
      "expected authored ifElse branch map to stay pattern-lowered",
    );
  },
);

Deno.test(
  "Capability-first: derive object-literal input preserves property schemas",
  async () => {
    const source = `/// <cts-enable />
import { cell, derive, lift } from "commontools";

const stage = cell<string>("initial");
const attemptCount = cell<number>(0);
const acceptedCount = cell<number>(0);
const rejectedCount = cell<number>(0);

const normalizedStage = lift((value: string) => value)(stage);
const attempts = lift((count: number) => count)(attemptCount);
const accepted = lift((count: number) => count)(acceptedCount);
const rejected = lift((count: number) => count)(rejectedCount);

const _summary = derive(
  {
    stage: normalizedStage,
    attempts: attempts,
    accepted: accepted,
    rejected: rejected,
  },
  (snapshot) =>
    \`stage:\${snapshot.stage} attempts:\${snapshot.attempts}\` +
    \` accepted:\${snapshot.accepted} rejected:\${snapshot.rejected}\`,
);
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "stage: {");
    assertStringIncludes(output, "attempts: {");
    assertStringIncludes(output, "accepted: {");
    assertStringIncludes(output, "rejected: {");
    assert(!output.includes("stage: true"));
    assert(!output.includes("attempts: true"));
    assert(!output.includes("accepted: true"));
    assert(!output.includes("rejected: true"));
  },
);

Deno.test(
  "Capability-first: derive wildcard usage keeps conservative full-shape input schema",
  async () => {
    const source = `/// <cts-enable />
import { derive, type Writable } from "commontools";
const input = {} as Writable<{ foo: string; bar: string }>;
const d = derive(input, (v: Writable<{ foo: string; bar: string }>) => {
  const foo = v.key("foo").get();
  Object.keys(v.get());
  return foo;
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assertStringIncludes(output, '"bar"');
  },
);

Deno.test(
  "Capability-first: handler wildcard usage keeps conservative full-shape state schema",
  async () => {
    const source = `/// <cts-enable />
import { handler, type Writable } from "commontools";
const h = handler((event: { id: string }, state: Writable<{ foo: string; bar: string }>) => {
  const foo = state.key("foo").get();
  Object.keys(state.get());
  return foo + event.id;
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assertStringIncludes(output, '"bar"');
  },
);

// ── Property names that collide with method names ──────────────────────────

Deno.test(
  "Capability-first: state property named 'filter' is lowered to .key()",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commontools";
interface State { filter: string; items: string[] }
const p = pattern<State>((state) => ({
  [UI]: <div>{state.filter}</div>,
}));
`;
    const output = await transformSource(source, { types: COMMONTOOLS_TYPES });
    assertStringIncludes(output, 'state.key("filter")');
    assert(!output.includes("filterWithPattern"));
  },
);

Deno.test({
  name: "Capability-first: state property named 'map' is lowered to .key()",
  fn: async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commontools";
interface State { map: string }
const p = pattern<State>((state) => ({
  [UI]: <div>{state.map}</div>,
}));
`;
    const output = await transformSource(source, { types: COMMONTOOLS_TYPES });
    assertStringIncludes(output, 'state.key("map")');
  },
});

Deno.test({
  name: "Capability-first: state property named 'set' is lowered to .key()",
  fn: async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commontools";
interface State { set: string }
const p = pattern<State>((state) => ({
  [UI]: <div>{state.set}</div>,
}));
`;
    const output = await transformSource(source, { types: COMMONTOOLS_TYPES });
    assertStringIncludes(output, 'state.key("set")');
  },
});

// ── Unsupported array methods in JSX ───────────────────────────────────────

Deno.test(
  "Capability-first: .find() on reactive array in JSX is lowered to .key()",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commontools";
interface Item { id: number; name: string }
interface State { items: Item[] }
const p = pattern<State>((state) => ({
  [UI]: <div>{state.items.find((item) => item.id === 1)?.name}</div>,
}));
`;
    const output = await transformSource(source, { types: COMMONTOOLS_TYPES });
    // find is not a supported reactive method — it should not be
    // transformed to findWithPattern
    assert(!output.includes("findWithPattern"));
  },
);
