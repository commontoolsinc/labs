import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { CFC_TRANSFORMER_STAGE_NAMES } from "../src/cf-pipeline.ts";
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
  "Pipeline regression: CFC transformer stages stay in the fixed order",
  () => {
    assertEquals(CFC_TRANSFORMER_STAGE_NAMES, [
      "CastValidationTransformer",
      "EmptyArrayOfValidationTransformer",
      "OpaqueGetValidationTransformer",
      "PatternContextValidationTransformer",
      "JsxExpressionSiteRouterTransformer",
      "LiftLoweringTransformer",
      "ClosureTransformer",
      "PatternOwnedExpressionSiteLoweringTransformer",
      "HelperOwnedExpressionSiteLoweringTransformer",
      "WriteAuthorizedByValidationTransformer",
      "PatternCallbackLoweringTransformer",
      "BuilderCallbackHoistingTransformer",
      "SchemaInjectionTransformer",
      "SchemaGeneratorTransformer",
      "ReactiveVariableForTransformer",
      "ModuleScopeShadowingTransformer",
      "ModuleScopeCfDataTransformer",
      "ModuleScopeFunctionHardeningTransformer",
    ]);
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

    // Test intent: imported well-known CF keys (NAME/UI/SELF/FS) must never
    // appear as bare identifiers in the lowered output — they must always be
    // helper-backed (__cfHelpers.NAME etc.). After CT-1586, well-known CF
    // keys on tracked-opaque roots lower to `expr.key(__cfHelpers.NAME)`
    // in-place rather than being wrapped in `derive(..., ({c}) =>
    // c[__cfHelpers.NAME])`. The surface form must include the helper
    // expression on the `c` root specifically — generic substring
    // checks could pass even if `c` got renamed by an unrelated bug.
    assertStringIncludes(output, "c.key(__cfHelpers.NAME)");
    assert(
      !output.includes("c.key(NAME)") && !output.includes("c[NAME]"),
      "Bare NAME identifier must not appear in lowered output",
    );
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
    // After CT-1615 Phase 1, the synthesized wrapper is lift-applied:
    //   __cfHelpers.lift<...>(({ f }) => f.validationIssue !== undefined)(
    //     { validationIssue: f.key("validationIssue") }
    //   )
    // The callback lives on the inner lift call; the input on the outer
    // applied call.
    assertMatch(
      output,
      /__cfHelpers\.lift\([\s\S]*\(\{ f \}\) => f\.validationIssue !== undefined\)\(\{[\s\S]*validationIssue: f(?:\.validationIssue|\.key\("validationIssue"\))[\s\S]*\}\)/,
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
  "Pipeline regression: mapped pattern factory calls with element fields stay structural",
  async () => {
    const source = `import { UI, pattern, type VNode } from "commonfabric";

type Entry = {
  piece: any;
  name: string;
  backlinks: any[];
};

const EntryRow = pattern<Entry, { [UI]: VNode }>(({ piece, backlinks }) => ({
  [UI]: <div>{piece}{backlinks.length}</div>,
}));

export default pattern<{ entries: Entry[] }, { [UI]: VNode }>(({ entries }) => ({
  [UI]: (
    <div>
      {entries.map((entry) => {
        const row = EntryRow({
          piece: entry.piece,
          name: entry.name,
          backlinks: entry.backlinks,
        });
        return row[UI];
      })}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(output, "const row = EntryRow({");
    assertStringIncludes(output, 'piece: entry.key("piece")');
    assertStringIncludes(output, 'name: entry.key("name")');
    assertStringIncludes(output, 'backlinks: entry.key("backlinks")');
    // CT-1586: row[UI] must lower to row.key(__cfHelpers.UI) in-place,
    // never to a derive wrapper around the [UI] element access. This is
    // the exact ticket repro — without the assertion below, the bug
    // (derive(..., ({row}) => row[__cfHelpers.UI])) would have passed the
    // outer "stays structural" check above unnoticed.
    assertStringIncludes(output, "row.key(__cfHelpers.UI)");
    assert(
      !/__cfHelpers\.derive\([\s\S]{0,500}EntryRow: EntryRow[\s\S]{0,500}EntryRow\(\{/
        .test(
          output,
        ),
      "expected mapped pattern factory invocation to stay structural instead of being wrapped in derive",
    );
  },
);

Deno.test(
  "Pipeline regression: plain callables that lack pattern-factory shape are not classified as opaque-origin calls (CT-1586 boundary)",
  async () => {
    // CT-1586 extended `isOpaqueOriginCall` to recognize structural pattern
    // factories via `isPatternFactoryCalleeExpression`, which requires the
    // callee type to expose both `argumentSchema` and `resultSchema`
    // properties (and NOT `with`). A plain user-authored helper that
    // returns a regular value should NOT trip the new gate.
    //
    // The call itself must therefore be wrapped in derive(...) when used
    // inside a reactive context — that's the pre-existing behavior for
    // non-opaque-origin calls. If `isPatternFactoryCalleeExpression`
    // started false-positively matching plain helpers (e.g. due to type
    // widening), we'd see the plainHelper call land structurally instead
    // of being derive-wrapped. This test locks in the boundary.
    const source = `import { pattern, UI, type VNode } from "commonfabric";

interface Entry { piece: string }

function plainHelper(input: { piece: string }): { rendered: string; [UI]: string } {
  return { rendered: input.piece, [UI]: input.piece };
}

export default pattern<{ entries: Entry[] }, { [UI]: VNode }>(({ entries }) => ({
  [UI]: (
    <div>
      {entries.map((entry) => {
        const row = plainHelper({ piece: entry.piece });
        return row[UI];
      })}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    // The plain helper call is preserved.
    assertStringIncludes(output, "plainHelper(");
    // Because plainHelper is NOT classified as opaque-origin, the call
    // result must be derive-wrapped — the call should appear inside a
    // synthetic compute callback's body. The arrow `({ entry }) =>
    // plainHelper(...)` is the tell. If isPatternFactoryCalleeExpression
    // matched it, the call would land structurally as `const row =
    // plainHelper(...)` with no surrounding derive.
    assertStringIncludes(output, "}) => plainHelper(");
    assert(
      !/const row = plainHelper\(/.test(output),
      "expected plainHelper call to be wrapped in derive(...) — non-opaque-origin calls must NOT be treated as pattern factories",
    );
  },
);

Deno.test(
  "Pipeline regression: dynamic key access on pattern-factory result still wraps in derive (CT-1586 boundary)",
  async () => {
    // After CT-1586, well-known CF computed keys (UI/NAME/SELF/FS) lower
    // to `.key()` in-place even when the access lives inside a JSX slot.
    // But genuinely-dynamic key access — where the argument resolves to a
    // value that isn't a static path segment — must STILL go through the
    // dynamic-wrap (derive) path. The reorder in pattern-body-reactive-
    // root-lowering is gated on `info?.root && !info.dynamic`; this test
    // exercises the `info.dynamic === true` branch to lock in that
    // boundary.
    const source = `import { pattern, UI, type VNode } from "commonfabric";

type Entry = { piece: string; fieldName: string };
type Row = Record<string, string> & { [UI]: VNode };

const EntryRow = pattern<Entry, Row>(({ piece }) => ({
  [UI]: <span>{piece}</span>,
  body: piece,
}));

export default pattern<{ entries: Entry[] }, { [UI]: VNode }>(({ entries }) => ({
  [UI]: (
    <div>
      {entries.map((entry) => {
        const row = EntryRow({ piece: entry.piece, fieldName: entry.fieldName });
        // Dynamic key — entry.fieldName is a reactive string, not a known
        // static path segment.
        return row[entry.fieldName.toString()];
      })}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    // The pattern-factory call itself still stays structural.
    assertStringIncludes(output, "const row = EntryRow({");
    // The dynamic access should NOT have lowered to `.key()` — `.key()` is
    // only valid for known-static path segments. The dynamic-wrap path
    // is responsible for this case.
    assert(
      !/row\.key\(entry\./.test(output),
      "expected dynamic key access not to lower to row.key(...)",
    );
  },
);

Deno.test(
  "Pipeline regression: module-scope sub-pattern calls in maps stay structural",
  async () => {
    const source = `import { pattern, UI, type VNode } from "commonfabric";

type Entry = { value: number };

const EntryRow = pattern<Entry, { [UI]: VNode }>(({ value }) => ({
  [UI]: <span>{value}</span>,
}));

export default pattern<{ entries: Entry[] }, { [UI]: VNode }>(({ entries }) => ({
  [UI]: (
    <div>
      {entries.map((entry) => {
        const row = EntryRow({ value: entry.value });
        return row[UI];
      })}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(output, "const row = EntryRow({");
    assert(
      !output.includes("EntryRow: EntryRow"),
      "expected module-scope pattern factory to stay in lexical scope instead of being captured as derive data",
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

    // After CT-1615 Phase 1, derive(values, cb) lowers to lift(cb)(values):
    // const result = __cfHelpers.lift(argSchema, resSchema, cb)(values).for(...)
    assertMatch(
      normalized,
      /const result = __cfHelpers\.lift\([\s\S]*?, (?:__cfModuleCallback_\d+|\(entries\) => summarize\(entries\.get\(\)\))\)\(values\)\.for\("result", true\);/,
    );
  },
);

Deno.test(
  "Pipeline regression: local concise ternary event handlers stay function-valued",
  async () => {
    const source =
      `import { derive, handler, pattern, UI, Writable } from "commonfabric";

interface Item {
  id: string;
}

interface Vote {
  itemId: string;
  vote: "yes" | "no";
}

const castVote = handler<{ itemId: string; vote: "yes" }, { votes: Writable<Vote[]> }>(
  (event, { votes }) => {
    votes.push(event);
  },
);

const clearVote = handler<{ itemId: string }, {}>(() => {});

export default pattern<{ items: Writable<Item[]>; votes: Writable<Vote[]> }>(
  ({ items, votes }) => {
    const boundCastVote = castVote({ votes });
    const boundClearVote = clearVote({});

    return {
      [UI]: (
        <div>
          {items.map((item) => {
            const iid = item.id;
            const myVote = derive(
              { votes, itemId: iid },
              ({ votes, itemId }) =>
                votes.get().find((vote) => vote.itemId === itemId)?.vote,
            );

            const onVoteYes = () =>
              myVote === "yes"
                ? boundClearVote.send({ itemId: iid })
                : boundCastVote.send({ itemId: iid, vote: "yes" });

            return <cf-button onClick={onVoteYes}>yes</cf-button>;
          })}
        </div>
      ),
    };
  },
);
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertStringIncludes(output, 'const onVoteYes = () => myVote === "yes"');
    assertStringIncludes(output, "boundClearVote.send({ itemId: iid })");
    assertStringIncludes(
      output,
      'boundCastVote.send({ itemId: iid, vote: "yes" })',
    );
    assert(
      !output.includes("const onVoteYes = __cfHelpers.derive("),
      "local event handler variable must not become a derive cell containing a function",
    );
    assert(
      !output.includes("=> () => __cfHelpers.ifElse("),
      "local event handler body must keep imperative ternary semantics",
    );
  },
);

Deno.test(
  "Pipeline regression: helper-owned IIFE local cell reads lower before use",
  async () => {
    const source = `import { pattern, UI, Writable } from "commonfabric";

export default pattern<{ enabled: Writable<boolean> }>(({ enabled }) => ({
  [UI]: <div>{(() => {
    const raw = enabled.get();
    return typeof raw === "boolean" ? raw : true;
  })()}</div>,
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assert(
      !output.includes("const raw = enabled.get();"),
      "expected the eager cell read to be lowered into a derive before the IIFE body uses it",
    );
    assertStringIncludes(output, "({ enabled }) => enabled.get()");
  },
);

Deno.test(
  "Pipeline regression: nullable computed capture keeps source array schema array-shaped",
  async () => {
    const source =
      `import { computed, derive, pattern, UI } from "commonfabric";

interface Option {
  title: string;
  ignored: string;
}

export default pattern<{ options: Option[] }, { [UI]: any }>(({ options }) => {
  const minimalNullable = derive(
    options,
    (o) => o.length > 0 ? o[0].title : null,
  );

  return {
    [UI]: (
      <div>
        {computed(() => {
          const value = minimalNullable;
          return <span>{value ?? "null"}</span>;
        })}
      </div>
    ),
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    // After CT-1615 Phase 1, the user-authored `derive(options, ...)`
    // lowers to `__cfHelpers.lift(...)(options)`.
    const minimalNullableStart = output.indexOf(
      "const minimalNullable = __cfHelpers.lift(",
    );
    assert(
      minimalNullableStart >= 0,
      "expected transformed minimalNullable lift-applied call",
    );
    const minimalNullableWindow = output.slice(
      minimalNullableStart,
      minimalNullableStart + 1200,
    );

    assertStringIncludes(minimalNullableWindow, 'type: "array"');
    assertStringIncludes(minimalNullableWindow, "items:");
    assertStringIncludes(minimalNullableWindow, "title:");
    assertStringIncludes(minimalNullableWindow, 'type: "null"');
    assert(
      !minimalNullableWindow.includes('properties: {\n        "0"'),
      "expected the derive input schema to stay array-shaped, not shrink to an object with numeric keys",
    );
    assert(
      !minimalNullableWindow.includes('required: ["length", "0"]'),
      "expected the derive input schema not to require object-style array members",
    );
  },
);

Deno.test(
  "Pipeline regression: computed captures preserve destructured PerUser defaults",
  async () => {
    const source =
      `import { computed, Default, NAME, pattern, type PerSpace, type PerUser, UI, type VNode } from "commonfabric";

const trimmedName = (name: string | undefined) => (name ?? "").trim();

interface Input {
  question?: PerSpace<string | Default<"Where should we eat?">>;
  myName?: PerUser<string | Default<"">>;
}

export default pattern<Input, { [NAME]: string; [UI]: VNode }>(({ question, ["myName"]: displayName }) => ({
  [NAME]: "ct-1606",
  [UI]: (
    <cf-screen>
      <div slot="header">
        <h2>{question}</h2>
        {computed(() => {
          const value = trimmedName(displayName);
          return <div>me is: "{value}"</div>;
        })}
      </div>
      <div>body renders</div>
    </cf-screen>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    // After CT-1615 Phase 1, computed() lowers to lift-applied:
    //   __cfHelpers.lift<...>({argSchema}, {resSchema}, cb)({inputObj})
    // The lift call (with generic type args) begins the wrapper; the
    // captured displayName lives in the outer applied call's input object.
    // Match the lift identifier with optional type arguments via regex.
    const liftMatch = output.match(/__cfHelpers\.lift\s*</);
    assert(
      liftMatch && liftMatch.index !== undefined,
      "expected computed() to lower to lift-applied; output had no __cfHelpers.lift<",
    );
    const liftWindow = output.slice(liftMatch.index, liftMatch.index + 1200);

    // Capture-input properties appear in the outer applied call's argument.
    assertStringIncludes(liftWindow, "displayName: {");
    assertStringIncludes(liftWindow, 'type: "string"');
    assertStringIncludes(liftWindow, '"default": ""');
    assertStringIncludes(liftWindow, 'scope: "user"');
  },
);

Deno.test(
  "Pipeline regression: computed captures preserve destructured Writable defaults",
  async () => {
    const source =
      `import { computed, Default, NAME, pattern, UI, type VNode, type Writable } from "commonfabric";

interface Input {
  draftTitle: Writable<string | Default<"">>;
}

export default pattern<Input, { [NAME]: string; [UI]: VNode }>(({ draftTitle }) => ({
  [NAME]: "writable-default-capture",
  [UI]: <div>{computed(() => <span>{draftTitle}</span>)}</div>,
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    // After CT-1615 Phase 1, computed() lowers to lift-applied.
    const liftMatch = output.match(/__cfHelpers\.lift\s*</);
    assert(
      liftMatch && liftMatch.index !== undefined,
      "expected computed() to lower to lift-applied; output had no __cfHelpers.lift<",
    );
    const liftWindow = output.slice(liftMatch.index, liftMatch.index + 1200);

    assertStringIncludes(liftWindow, "draftTitle: {");
    assertStringIncludes(liftWindow, 'type: "string"');
    assertStringIncludes(liftWindow, '"default": ""');
    assertStringIncludes(liftWindow, "asCell:");
  },
);

Deno.test(
  "Pipeline regression: computed captures preserve Writable Record defaults without orphan refs",
  async () => {
    const source =
      `import { computed, Default, NAME, pattern, UI, type VNode, type Writable } from "commonfabric";

interface Input {
  selections: Writable<Record<string, boolean> | Default<Record<string, never>>>;
}

export default pattern<Input, { [NAME]: string; [UI]: VNode }>(({ selections }) => ({
  [NAME]: "writable-record-default-capture",
  [UI]: <div>{computed(() => selections.foo ? "yes" : "no")}</div>,
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    // After CT-1615 Phase 1, computed() lowers to lift-applied.
    const liftMatch = output.match(/__cfHelpers\.lift\s*</);
    assert(
      liftMatch && liftMatch.index !== undefined,
      "expected computed() to lower to lift-applied; output had no __cfHelpers.lift<",
    );
    const liftWindow = output.slice(liftMatch.index, liftMatch.index + 1400);

    assertStringIncludes(liftWindow, "selections:");
    assert(
      !liftWindow.includes("AnonymousType_"),
      "expected Writable<Record<...Default...>> capture not to emit orphan anonymous refs",
    );
  },
);

Deno.test(
  "Pipeline regression: side-writing computed marks writable inputs for materialization",
  async () => {
    const source =
      `import { computed, pattern, type Writable } from "commonfabric";

interface Input {
  departments: Writable<string[]>;
}

export default pattern<Input>(({ departments }) => {
  const init = computed(() => {
    if (departments.get().length === 0) departments.set(["Bakery"]);
    return true;
  });
  return { init };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const liftMatch = output.match(/const init = __cfHelpers\.lift\s*</);
    assert(
      liftMatch && liftMatch.index !== undefined,
      "expected computed() to lower to lift()",
    );
    const liftWindow = output.slice(liftMatch.index, liftMatch.index + 1400);

    assertStringIncludes(liftWindow, "materializerWriteInputPaths");
    assertStringIncludes(liftWindow, '["departments"]');
  },
);

Deno.test(
  "Pipeline regression: readonly computed does not mark writable-looking inputs for materialization",
  async () => {
    const source =
      `import { computed, pattern, type Writable } from "commonfabric";

interface Input {
  departments: Writable<string[]>;
}

export default pattern<Input>(({ departments }) => {
  const count = computed(() => departments.get().length);
  return { count };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const liftMatch = output.match(/const count = __cfHelpers\.lift\s*</);
    assert(
      liftMatch && liftMatch.index !== undefined,
      "expected computed() to lower to lift()",
    );
    const liftWindow = output.slice(liftMatch.index, liftMatch.index + 1200);

    assert(
      !liftWindow.includes("materializerWriteInputPaths"),
      "readonly computed() should remain a normal pull computation",
    );
  },
);
