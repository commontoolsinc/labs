import {
  assert,
  assertEquals,
  assertGreater,
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
  "Capability-first: plain array callbacks inside computed stay plain",
  async () => {
    const source = `/// <cts-enable />
import { computed, pattern, UI } from "commontools";

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
      const doneToday = computed(() =>
        logs.get().some(
          (log) =>
            log.habitName === habit.name &&
            log.date === todayDate &&
            log.completed,
        )
      );
      return <span>{doneToday ? "yes" : "no"}</span>;
    })}</div>,
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(
      output,
      "logs.get().some((log) => log.habitName === habit.name &&",
    );
    assert(
      !output.includes("logs.get().some((log) => __ctHelpers.when("),
      "plain array some() callback should stay plain inside computed()/derive()",
    );
  },
);

Deno.test(
  "Capability-first: aliased get-result callbacks inside computed stay plain",
  async () => {
    const source = `/// <cts-enable />
import { computed, pattern, UI } from "commontools";

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
      types: COMMONTOOLS_TYPES,
    });

    assertStringIncludes(
      output,
      "const logList = logs.get();",
    );
    assertStringIncludes(
      output,
      "return logList.some((log) => log.habitName === habit.name &&",
    );
    assert(
      !output.includes("return logList.some((log) => __ctHelpers.when("),
      "aliased plain array some() callback should stay plain inside computed()/derive()",
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
