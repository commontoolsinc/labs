import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "@std/assert";
import { transformSource, validateSource } from "./utils.ts";

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
