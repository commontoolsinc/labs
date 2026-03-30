import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { transformSource, validateSource } from "./utils.ts";
import { COMMONTOOLS_TYPES } from "./commontools-test-types.ts";

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
  "Capability-first: manual mapWithPattern preserves computed plain-capture keys",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commontools";
const key = "small" as const;
const p = pattern<{ items: string[] }>((state) => ({
  [UI]: (
    <div>
      {state.items.mapWithPattern(
        pattern(({ params: { style: { [key]: fontSize } } }) => (
          <span>{fontSize}</span>
        )),
        { style: { small: 12, large: 16 }, key },
      )}
    </div>
  ),
}));
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
      "const fontSize = __ct_pattern_input.params.style[key];",
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
      /__ctHelpers\.derive\([\s\S]*validationIssue: f(?:\.validationIssue|\.key\("validationIssue"\))[\s\S]*\(\{ f \}\) => f\.validationIssue !== undefined\)/,
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
  "Capability-first: helper-owned child key references stay structural",
  async () => {
    const source = `/// <cts-enable />
import { Cell, Default, handler, lift, pattern, Stream } from "commontools";

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
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(output, 'left: leftChild.key("value")');
    assertStringIncludes(output, 'right: rightChild.key("value")');
    assertStringIncludes(output, 'increment: rightChild.key("increment")');
    assert(
      !output.includes(
        '__ctHelpers.computed((): any => leftChild.key("value"))',
      ),
      "expected child value cell reference to stay structural inside helper-owned arguments",
    );
    assert(
      !output.includes(
        '__ctHelpers.computed((): any => rightChild.key("increment"))',
      ),
      "expected child stream reference to stay structural inside helper-owned arguments",
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
