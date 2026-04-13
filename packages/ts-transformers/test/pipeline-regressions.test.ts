import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { transformSource, validateSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

function extractSchemas(output: string): string[] {
  const schemas: string[] = [];
  const marker = "as const satisfies __cfHelpers.JSONSchema";
  let searchFrom = 0;
  while (true) {
    const markerIdx = output.indexOf(marker, searchFrom);
    if (markerIdx === -1) break;

    let start = markerIdx - 1;
    while (start >= 0 && /\s/.test(output[start]!)) start--;

    let schemaText: string | undefined;
    if (output[start] === "}") {
      let depth = 1;
      start--;
      while (start >= 0 && depth > 0) {
        if (output[start] === "}") depth++;
        else if (output[start] === "{") depth--;
        start--;
      }
      start++;
      schemaText = output.slice(start, markerIdx).trim();
    } else {
      let tokenStart = start;
      while (tokenStart >= 0 && /[A-Za-z]/.test(output[tokenStart]!)) {
        tokenStart--;
      }
      tokenStart++;
      const token = output.slice(tokenStart, start + 1).trim();
      if (token === "true" || token === "false") {
        schemaText = token;
      }
    }

    if (!schemaText) {
      searchFrom = markerIdx + marker.length;
      continue;
    }

    schemas.push(schemaText);
    searchFrom = markerIdx + marker.length;
  }
  return schemas;
}

Deno.test(
  "Pipeline regression: manual mapWithPattern preserves fixed plain-capture key evaluation",
  async () => {
    const source = `import { pattern, UI } from "commonfabric";
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
      types: COMMONFABRIC_TYPES,
    });
    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const computationDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-context:computation"
    );

    assertEquals(computationDiagnostics.length, 0);
    assertStringIncludes(
      output,
      "const fontSize = __cf_pattern_input.params.style[key];",
    );
    assert(!output.includes("__cf_pattern_input.params.style.small"));
  },
);

Deno.test(
  "Pipeline regression: opaque key lowering preserves literal-typed key evaluation",
  async () => {
    const source = `/// <cts-enable />
import { pattern, UI } from "commonfabric";
declare function getKey(): "title";
const p = pattern<{ item: { title: string } }>((state) => {
  const { [getKey()]: title } = state.item;
  return {
    [UI]: <div>{title}</div>,
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(
      output,
      'const __cf_destructure_1 = state.key("item"), title = __cf_destructure_1.key(getKey());',
    );
    assert(!output.includes('title = __cf_destructure_1.key("title")'));
  },
);

Deno.test(
  "Pipeline regression: imported Common Fabric keys stay helper-backed in rewrites",
  async () => {
    const source = `/// <cts-enable />
import { NAME, UI, pattern } from "commonfabric";

type MentionablePiece = { [NAME]?: string };

const p = pattern<{ mentionable: MentionablePiece[] }, { [UI]: any }>((
  { mentionable },
) => ({
  [UI]: <div>{mentionable.map((c) => c[NAME]!)}</div>,
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(output, "return c.key(__cfHelpers.NAME)!");
    assert(!output.includes("return c.key(NAME)!"));
  },
);

Deno.test(
  "Pipeline regression: nested writable map callbacks keep direct key reads in shrunk schemas",
  async () => {
    const source = await Deno.readTextFile(
      new URL(
        "./fixtures/kitchensink/nested-writable-pattern-branches.input.tsx",
        import.meta.url,
      ),
    );
    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const schemas = extractSchemas(output);

    const outerMapSchema =
      schemas.find((schema) =>
        schema.includes('required: ["element", "params"]') &&
        schema.includes("globalAccent") &&
        schema.includes("selectedTaskId") &&
        schema.includes("hoveredSectionId")
      ) ?? "";
    assert(outerMapSchema.length > 0, "expected outer sections map schema");
    assertStringIncludes(outerMapSchema, "id");
    assertStringIncludes(outerMapSchema, "title");
    assertStringIncludes(outerMapSchema, "expanded");
    assertStringIncludes(outerMapSchema, "accent");
    assertStringIncludes(outerMapSchema, "tasks");

    const innerMapSchema =
      schemas.find((schema) =>
        schema.includes('required: ["element", "params"]') &&
        schema.includes("sectionIndex") &&
        schema.includes("selectedTaskId") &&
        schema.includes("hoveredSectionId") &&
        !schema.includes("globalAccent")
      ) ?? "";
    assert(innerMapSchema.length > 0, "expected inner tasks map schema");
    assertStringIncludes(innerMapSchema, "id");
    assertStringIncludes(innerMapSchema, "label");
    assertStringIncludes(innerMapSchema, "done");
    assertStringIncludes(innerMapSchema, "tags");
    assertStringIncludes(innerMapSchema, "note");
  },
);

Deno.test(
  "Pipeline regression: nested authored ifElse predicate in helper-owned branch lowers to derive",
  async () => {
    const source =
      `import { computed, ifElse, pattern, UI } from "commonfabric";

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
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(
      output,
      "=> f.validationIssue !== undefined",
    );
    assertMatch(
      output,
      /__cfHelpers\.derive\([\s\S]*validationIssue: f(?:\.validationIssue|\.key\("validationIssue"\))[\s\S]*\(\{ f \}\) => f\.validationIssue !== undefined\)/,
    );
  },
);

Deno.test(
  "Pipeline regression: dynamic key access in helper-owned map callback initializer lowers without computation diagnostics",
  async () => {
    const source =
      `import { computed, ifElse, pattern, UI } from "commonfabric";

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
      types: COMMONFABRIC_TYPES,
    });
    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
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
  "Pipeline regression: self-improving classifier examples map keeps examples capture",
  async () => {
    const source = await Deno.readTextFile(
      new URL("../../patterns/self-improving-classifier.tsx", import.meta.url),
    );
    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const mapStart = output.indexOf("{examples.mapWithPattern(");
    assert(
      mapStart >= 0,
      "expected transformed examples.mapWithPattern callback",
    );
    const mapWindow = output.slice(mapStart, mapStart + 5000);

    assertStringIncludes(
      mapWindow,
      'const selectedExampleId = __cf_pattern_input.key("params", "selectedExampleId");',
    );
    assertStringIncludes(
      mapWindow,
      'const currentItem = __cf_pattern_input.key("params", "currentItem");',
    );
    assertStringIncludes(
      mapWindow,
      'const examples = __cf_pattern_input.key("params", "examples");',
    );
  },
);

Deno.test(
  "Pipeline regression: shopping-list sorted ifElse branch does not wrap mapped results in derive",
  async () => {
    const source = await Deno.readTextFile(
      new URL("../../patterns/shopping-list.tsx", import.meta.url),
    );
    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
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
  "Pipeline regression: imported pattern factory calls with local cells stay structural",
  async () => {
    const source =
      `import { Writable, pattern, type PatternFactory } from "commonfabric";

declare const Child: PatternFactory<{ value: number }, { value: number }>;

export default pattern(() => {
  const value = Writable.of<number>(1);
  const child = Child({ value });

  return {
    childValue: child.key("value"),
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(output, "const child = Child({ value });");
    assertStringIncludes(output, 'childValue: child.key("value")');
    assert(
      !/__cfHelpers\.derive\([\s\S]{0,240}Child\(\{ value \}\)\)/.test(output),
      "expected pattern factory invocation to stay structural instead of being wrapped in derive",
    );
  },
);

Deno.test(
  "Pipeline regression: opaque-returning factory helpers with local cells stay structural",
  async () => {
    const source = `import { pattern, Writable } from "commonfabric";

function createAuthManager(input: { accountType: string }) {
  return pattern<{ accountType: string }, {
    auth: { email: string };
    fullUI: string;
  }>(({ accountType }) => ({
    auth: { email: accountType },
    fullUI: accountType,
  }))(input);
}

export default pattern(() => {
  const selectedAccountType = Writable.of<string>("default");
  const authManager = createAuthManager({
    accountType: selectedAccountType,
  });

  return {
    auth: authManager.key("auth"),
    ui: authManager.key("fullUI"),
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(output, "const authManager = createAuthManager({");
    assertStringIncludes(output, "accountType: selectedAccountType,");
    assert(
      !/__ctHelpers\.derive\([\s\S]{0,280}createAuthManager\(\{[\s\S]{0,120}accountType: selectedAccountType[\s\S]{0,120}\}\)\)/
        .test(
          output,
        ),
      "expected opaque-returning factory helper to stay structural instead of being wrapped in derive",
    );
  },
);

Deno.test(
  "Pipeline regression: derive callbacks that rely on contextual typing still receive injected schemas",
  async () => {
    const source = `import { derive, pattern } from "commonfabric";

const summarize = (values: string[]) => values.length;

export default pattern<{ values: string[] }>(({ values }) => {
  const result = derive(values, (entries) => summarize(entries.get()));
  return { result };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const normalized = output.replace(/\s+/g, " ");

    assertMatch(
      normalized,
      /const result = derive\([\s\S]*, values, (?:__cfModuleCallback_\d+|\(entries\) => summarize\(entries\.get\(\)\))\);/,
    );
  },
);
