export type CommonFabricRuntimeExportSpec =
  | {
    exportName: string;
    category: "builder";
    builderName: string;
    reactiveOrigin: boolean;
  }
  | {
    exportName: string;
    category: "call";
    callKind:
      | "cell-factory"
      | "lift-applied"
      | "ifElse"
      | "when"
      | "unless"
      | "wish"
      | "llm-dialog"
      | "generate-text"
      | "generate-object"
      | "pattern-tool"
      | "runtime-call"
      | "availability-result"
      | "partial-result"
      | "availability-observer";
    reactiveOrigin: boolean;
  }
  | {
    exportName: string;
    category: "call";
    callKind: "availability-guard";
    availabilityReason:
      | "pending"
      | "error"
      | "syncing"
      | "schema-mismatch";
    variantTypeName:
      | "IsPending"
      | "HasError"
      | "IsSyncing"
      | "HasSchemaMismatch";
    reactiveOrigin: boolean;
  }
  | {
    exportName: string;
    category: "ignored";
    reactiveOrigin: boolean;
  };

export const COMMONFABRIC_RUNTIME_EXPORT_REGISTRY = [
  {
    exportName: "pattern",
    category: "builder",
    builderName: "pattern",
    reactiveOrigin: true,
  },
  {
    exportName: "handler",
    category: "builder",
    builderName: "handler",
    reactiveOrigin: true,
  },
  {
    exportName: "action",
    category: "builder",
    builderName: "action",
    reactiveOrigin: true,
  },
  {
    exportName: "lift",
    category: "builder",
    builderName: "lift",
    reactiveOrigin: true,
  },
  {
    exportName: "computed",
    category: "builder",
    builderName: "computed",
    reactiveOrigin: true,
  },
  {
    exportName: "byRef",
    category: "ignored",
    reactiveOrigin: false,
  },
  {
    exportName: "render",
    category: "builder",
    builderName: "render",
    reactiveOrigin: true,
  },
  {
    exportName: "cell",
    category: "call",
    callKind: "cell-factory",
    reactiveOrigin: true,
  },
  {
    exportName: "ifElse",
    category: "call",
    callKind: "ifElse",
    reactiveOrigin: true,
  },
  {
    exportName: "when",
    category: "call",
    callKind: "when",
    reactiveOrigin: true,
  },
  {
    exportName: "unless",
    category: "call",
    callKind: "unless",
    reactiveOrigin: true,
  },
  {
    exportName: "wish",
    category: "call",
    callKind: "wish",
    reactiveOrigin: true,
  },
  {
    exportName: "generateText",
    category: "call",
    callKind: "generate-text",
    reactiveOrigin: true,
  },
  {
    exportName: "generateObject",
    category: "call",
    callKind: "generate-object",
    reactiveOrigin: true,
  },
  {
    exportName: "generateTextStream",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  // The advanced object stream takes the same result type parameter and
  // options-level `schema` as generateObject, so it deliberately shares the
  // dedicated call kind and schema-injection path.
  {
    exportName: "generateObjectStream",
    category: "call",
    callKind: "generate-object",
    reactiveOrigin: true,
  },
  {
    exportName: "patternTool",
    category: "call",
    callKind: "pattern-tool",
    reactiveOrigin: false,
  },
  {
    exportName: "str",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "llm",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "llmDialog",
    category: "call",
    callKind: "llm-dialog",
    reactiveOrigin: true,
  },
  {
    exportName: "fetchBinary",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "fetchText",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  // `fetchJson` additionally gets type-argument schema injection in
  // schema-injection.ts (lowering `fetchJson<T>` to an injected `schema`
  // parameter, like sqliteQuery's `rowSchema`), and is a compile error
  // without a type argument.
  {
    exportName: "fetchJson",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "fetchJsonUnchecked",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "fetchProgram",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "streamData",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "compileAndRun",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "navigateTo",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  // inspectConfLabel(target, targetPath, query) — the inv-12 Stage 2 bounded
  // label-introspection builtin (CFC spec §4.6.4.1). A plain node-factory
  // call returning a Reactive result, like navigateTo: no dedicated
  // CallKind, no schema injection (its argument schema is fixed on the
  // factory).
  {
    exportName: "inspectConfLabel",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  // SQLite builtins. `sqliteQuery` additionally gets dedicated type-argument
  // schema injection in schema-injection.ts (lowering `sqliteQuery<Row>` to an
  // injected `rowSchema`); the others are registered so the factory-injected
  // callables are recognized reactive-origin calls (registry guard test).
  {
    exportName: "sqliteDatabase",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "sqliteQuery",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  // uiVariant(piece, kind) returns a static `cf-render` VNode (it just calls
  // `h`); cf-render owns all reactivity at render time. The transformer needs no
  // special handling — it is not a reactive-origin call and gets no dedicated
  // CallKind, so it is "ignored" (treated as a plain call, like `byRef`).
  {
    exportName: "uiVariant",
    category: "ignored",
    reactiveOrigin: false,
  },
  {
    exportName: "isPending",
    category: "call",
    callKind: "availability-guard",
    availabilityReason: "pending",
    variantTypeName: "IsPending",
    reactiveOrigin: true,
  },
  {
    exportName: "hasError",
    category: "call",
    callKind: "availability-guard",
    availabilityReason: "error",
    variantTypeName: "HasError",
    reactiveOrigin: true,
  },
  {
    exportName: "isSyncing",
    category: "call",
    callKind: "availability-guard",
    availabilityReason: "syncing",
    variantTypeName: "IsSyncing",
    reactiveOrigin: true,
  },
  {
    exportName: "hasSchemaMismatch",
    category: "call",
    callKind: "availability-guard",
    availabilityReason: "schema-mismatch",
    variantTypeName: "HasSchemaMismatch",
    reactiveOrigin: true,
  },
  {
    exportName: "resultOf",
    category: "call",
    callKind: "availability-result",
    reactiveOrigin: true,
  },
  {
    exportName: "partialResultOf",
    category: "call",
    callKind: "partial-result",
    reactiveOrigin: true,
  },
  {
    exportName: "latestComplete",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "observeAvailability",
    category: "call",
    callKind: "availability-observer",
    reactiveOrigin: true,
  },
] as const satisfies readonly CommonFabricRuntimeExportSpec[];

export const COMMONFABRIC_RUNTIME_EXPORTS_BY_NAME: ReadonlyMap<
  string,
  CommonFabricRuntimeExportSpec
> = new Map(
  COMMONFABRIC_RUNTIME_EXPORT_REGISTRY.map((
    entry,
  ) => [entry.exportName, entry]),
);

export const COMMONFABRIC_BUILDER_EXPORT_NAMES: ReadonlySet<string> = new Set(
  COMMONFABRIC_RUNTIME_EXPORT_REGISTRY
    .filter((entry) => entry.category === "builder")
    .map((entry) => entry.exportName),
);

export const COMMONFABRIC_CALL_EXPORT_NAMES: ReadonlySet<string> = new Set(
  COMMONFABRIC_RUNTIME_EXPORT_REGISTRY
    .filter((entry) => entry.category === "call")
    .map((entry) => entry.exportName),
);

export const COMMONFABRIC_REACTIVE_ORIGIN_BUILDER_NAMES: ReadonlySet<string> =
  new Set(
    COMMONFABRIC_RUNTIME_EXPORT_REGISTRY
      .filter((entry) => entry.category === "builder" && entry.reactiveOrigin)
      .map((entry) => entry.builderName),
  );

export const COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES: ReadonlySet<
  string
> = new Set(
  COMMONFABRIC_RUNTIME_EXPORT_REGISTRY
    .filter((entry) => entry.category === "call" && entry.reactiveOrigin)
    .map((entry) => entry.exportName),
);
