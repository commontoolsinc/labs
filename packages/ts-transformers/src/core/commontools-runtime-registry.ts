export type CommonToolsRuntimeExportSpec =
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
      | "derive"
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

export const COMMONTOOLS_RUNTIME_EXPORT_REGISTRY = [
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
    exportName: "derive",
    category: "call",
    callKind: "derive",
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
] as const satisfies readonly CommonToolsRuntimeExportSpec[];

export const COMMONTOOLS_RUNTIME_EXPORTS_BY_NAME: ReadonlyMap<
  string,
  CommonToolsRuntimeExportSpec
> = new Map(
  COMMONTOOLS_RUNTIME_EXPORT_REGISTRY.map((entry) => [entry.exportName, entry]),
);

export const COMMONTOOLS_BUILDER_EXPORT_NAMES: ReadonlySet<string> = new Set(
  COMMONTOOLS_RUNTIME_EXPORT_REGISTRY
    .filter((entry) => entry.category === "builder")
    .map((entry) => entry.exportName),
);

export const COMMONTOOLS_CALL_EXPORT_NAMES: ReadonlySet<string> = new Set(
  COMMONTOOLS_RUNTIME_EXPORT_REGISTRY
    .filter((entry) => entry.category === "call")
    .map((entry) => entry.exportName),
);

export const COMMONTOOLS_REACTIVE_ORIGIN_BUILDER_NAMES: ReadonlySet<string> =
  new Set(
    COMMONTOOLS_RUNTIME_EXPORT_REGISTRY
      .filter((entry) => entry.category === "builder" && entry.reactiveOrigin)
      .map((entry) => entry.builderName),
  );

export const COMMONTOOLS_REACTIVE_ORIGIN_CALL_EXPORT_NAMES: ReadonlySet<
  string
> = new Set(
  COMMONTOOLS_RUNTIME_EXPORT_REGISTRY
    .filter((entry) => entry.category === "call" && entry.reactiveOrigin)
    .map((entry) => entry.exportName),
);
