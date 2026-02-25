import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "@std/assert";
import { transformSource, validateSource } from "./utils.ts";
import { COMMONTOOLS_TYPES } from "./commontools-test-types.ts";

Deno.test("Capability-first: pattern JSX lowers && with when()", async () => {
  const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern(({ foo, user: { name } }) => <div>{foo && name}</div>);
`;

  const output = await transformSource(source, {
    useLegacyOpaqueRefSemantics: false,
  });

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

  const output = await transformSource(source, {
    useLegacyOpaqueRefSemantics: false,
  });

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

    const output = await transformSource(source, {
      useLegacyOpaqueRefSemantics: false,
    });

    assertStringIncludes(output, "list.map((item) => item)");
    assert(!output.includes(".mapWithPattern("));
  },
);

Deno.test(
  "Capability-first: rewritten mapWithPattern callback uses key(...) canonicalization",
  async () => {
    const source = `/// <cts-enable />
import { pattern, derive } from "commontools";
const p = pattern((input: { list: Array<{ name: string; age: number }> }) => <div>{derive(input.list, (v) => v).map(({ name }) => <span>{name}</span>)}</div>);
`;

    const output = await transformSource(source, {
      useLegacyOpaqueRefSemantics: false,
    });

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

    const { diagnostics } = await validateSource(source, {
      useLegacyOpaqueRefSemantics: false,
    });
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
  "Capability-first diagnostics: optional-call stays blocked in pattern context",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern((input) => input?.foo());
`;

    const { diagnostics } = await validateSource(source, {
      useLegacyOpaqueRefSemantics: false,
    });

    const optionalDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:optional-chaining"
    );

    assert(optionalDiagnostics.length >= 1);
    assertStringIncludes(optionalDiagnostics[0]!.message, "Optional-call");
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

    const { diagnostics } = await validateSource(source, {
      useLegacyOpaqueRefSemantics: false,
    });

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

    const { diagnostics } = await validateSource(source, {
      useLegacyOpaqueRefSemantics: false,
    });

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

    const { diagnostics } = await validateSource(source, {
      useLegacyOpaqueRefSemantics: false,
    });

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
      useLegacyOpaqueRefSemantics: false,
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
  },
);

Deno.test(
  "Capability-first: pattern input shrinks to observed key paths",
  async () => {
    const source = `/// <cts-enable />
import { pattern, type Writable } from "commontools";
const p = pattern((input: Writable<{ foo: string; bar: string }>) => input.key("foo").get());
`;

    const output = await transformSource(source, {
      useLegacyOpaqueRefSemantics: false,
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assert(!output.includes('"bar"'));
  },
);

Deno.test(
  "Capability-first: pattern explicit type arguments still shrink input paths",
  async () => {
    const source = `/// <cts-enable />
import { pattern, type Writable } from "commontools";
const p = pattern<Writable<{ foo: string; bar: string }>, { foo: string }>((input) => ({
  foo: input.key("foo").get(),
}));
`;

    const output = await transformSource(source, {
      useLegacyOpaqueRefSemantics: false,
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assert(!output.includes('"bar"'));
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
      useLegacyOpaqueRefSemantics: false,
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
      useLegacyOpaqueRefSemantics: false,
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
      useLegacyOpaqueRefSemantics: false,
      types: COMMONTOOLS_TYPES,
    });

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
      useLegacyOpaqueRefSemantics: false,
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asOpaque: true");
    assertStringIncludes(output, '"foo"');
    assertStringIncludes(output, '"bar"');
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
      useLegacyOpaqueRefSemantics: false,
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
      useLegacyOpaqueRefSemantics: false,
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assert(!output.includes('"bar"'));
  },
);

Deno.test(
  "Capability-first diagnostics: pattern spread traversal emits computation code",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern((input) => ({ ...input }));
`;

    const { diagnostics } = await validateSource(source, {
      useLegacyOpaqueRefSemantics: false,
    });
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

    const { diagnostics } = await validateSource(source, {
      useLegacyOpaqueRefSemantics: false,
    });
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

    const { diagnostics } = await validateSource(source, {
      useLegacyOpaqueRefSemantics: false,
    });
    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assert(computationDiagnostics.length >= 1);
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

    const { diagnostics } = await validateSource(source, {
      useLegacyOpaqueRefSemantics: false,
    });
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

    const { diagnostics } = await validateSource(source, {
      useLegacyOpaqueRefSemantics: false,
    });
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
      useLegacyOpaqueRefSemantics: false,
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assertStringIncludes(output, '"bar"');
  },
);

Deno.test(
  "Legacy opt-out parity: explicit legacy mode matches default transform output",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern(({ foo, bar }) => <div>{foo && bar}</div>);
`;

    const defaultOutput = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const explicitLegacyOutput = await transformSource(source, {
      useLegacyOpaqueRefSemantics: true,
      types: COMMONTOOLS_TYPES,
    });

    assertEquals(explicitLegacyOutput, defaultOutput);
  },
);

Deno.test(
  "Legacy opt-out parity: explicit legacy mode matches default diagnostics",
  async () => {
    const source = `/// <cts-enable />
import { pattern } from "commontools";
const p = pattern((input) => input.get());
`;

    const defaultResult = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const explicitLegacyResult = await validateSource(source, {
      useLegacyOpaqueRefSemantics: true,
      types: COMMONTOOLS_TYPES,
    });

    const toComparable = (diagnostics: readonly {
      type: string;
      severity: string;
      message: string;
    }[]) =>
      diagnostics.map(({ type, severity, message }) => ({
        type,
        severity,
        message,
      }));

    assertEquals(
      toComparable(explicitLegacyResult.diagnostics),
      toComparable(defaultResult.diagnostics),
    );
  },
);

Deno.test(
  "Legacy opt-out parity: legacy mode keeps full-shape action state schema",
  async () => {
    const source = `/// <cts-enable />
import { action, pattern, type Writable } from "commontools";
const p = pattern((input: Writable<{ foo: string; bar: string }>) => {
  const a = action(() => input.key("foo").get());
  return a;
});
`;

    const output = await transformSource(source, {
      useLegacyOpaqueRefSemantics: true,
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, '"foo"');
    assertStringIncludes(output, '"bar"');
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
      useLegacyOpaqueRefSemantics: false,
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, ".mapWithPattern(");
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
      useLegacyOpaqueRefSemantics: false,
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "local.map((item) => item)");
    assert(!output.includes(".mapWithPattern("));
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
      useLegacyOpaqueRefSemantics: false,
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
      useLegacyOpaqueRefSemantics: false,
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, "asCell: true");
    assertStringIncludes(output, '"foo"');
    assertStringIncludes(output, '"bar"');
  },
);
