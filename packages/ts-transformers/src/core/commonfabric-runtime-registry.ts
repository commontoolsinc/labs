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
      | "generate-text"
      | "generate-object"
      | "pattern-tool"
      | "runtime-call";
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
    // Branded operator-expression lift (08-expression-interpretation §2/§3).
    // Structurally a lift: `__cfHelpers.exprLift(brand, cb)(operands)` is the same
    // single-application shape as `lift`, so its applied form is classified
    // `lift-applied` (see resolveExpressionKind) and ALL the lift-applied
    // downstream dispatchers — result-cause `.for(...)` stamping, double-wrap
    // suppression, schema injection, and builder-call hoisting — treat it
    // identically. The hoisting transformer DOES lift it to a module-scope const
    // (`__cfLift_N = exprLift(brand, argumentSchema, resultSchema, cb)`, the
    // dedup win), and because `exprLift` is a TRUSTED_BUILDERS member that const
    // is NOT `__cf_data`-wrapped — exactly like a hoisted `lift`/`computed`.
    exportName: "exprLift",
    category: "builder",
    builderName: "exprLift",
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
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "fetchData",
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
