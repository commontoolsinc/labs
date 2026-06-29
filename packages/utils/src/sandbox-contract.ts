export const SHADOWED_FACTORY_BINDINGS = [
  "define",
  "runtimeDeps",
  "__cfAmdHooks",
] as const;

export const TRUSTED_BUILDERS = Object.freeze(
  [
    "action",
    "computed",
    "derive",
    // Branded operator-expression lift (08-expression-interpretation). Exposed
    // ONLY via the trusted builder factory (never `__cf_data`-forgeable) and
    // structurally a `lift` — it wraps a pure synthetic operator arrow over its
    // operands, carrying the SAME `type:"javascript"` module a `lift` would plus
    // a `$builtin: "expr:<op>"` brand. It must be trusted-builder-recognized so
    // (a) its hoisted module-scope const is NOT `__cf_data`-wrapped (the wrap
    // freezes the returned NodeFactory and throws), and (b) the compiled-bundle
    // verifier classifies the call as a builder (not data). The function body is
    // verified identically to any `lift` body, so this widens nothing.
    "exprLift",
    "handler",
    "lift",
    // Identity tag for multi-user test descriptors (`cf test`); its
    // arguments are trusted-builder results, never event-carrying closures.
    "multiUserTest",
    "pattern",
  ] as const,
);
export type TrustedBuilderName = (typeof TRUSTED_BUILDERS)[number];
const TRUSTED_BUILDER_SET = new Set<string>(TRUSTED_BUILDERS);

export function isTrustedBuilder(name: string): name is TrustedBuilderName {
  return TRUSTED_BUILDER_SET.has(name);
}

export const TRUSTED_DATA_HELPERS = Object.freeze(
  [
    "schema",
    "__cf_data",
    "nonPrivateRandom",
    "safeDateNow",
  ] as const,
);
export type TrustedDataHelperName = (typeof TRUSTED_DATA_HELPERS)[number];
const TRUSTED_DATA_HELPER_SET = new Set<string>(TRUSTED_DATA_HELPERS);

export function isTrustedDataHelper(
  name: string,
): name is TrustedDataHelperName {
  return TRUSTED_DATA_HELPER_SET.has(name);
}

export const FUNCTION_HARDENING_HELPER_NAME = "__cfHardenFn";
export const BINDING_IDENTITY_HELPER_NAME = "__cfBindVerifiedBinding";
export const VERIFIED_BINDING_METADATA_FIELD = "__cfVerifiedBindingIdentity";

export const RESERVED_FACTORY_BINDINGS = [
  ...SHADOWED_FACTORY_BINDINGS,
] as const;

export function createFactoryShadowGuardSource(): string[] {
  return SHADOWED_FACTORY_BINDINGS.map((name) => `const ${name} = undefined;`);
}

export function createFunctionHardeningHelperSource(
  helperName = FUNCTION_HARDENING_HELPER_NAME,
  options: { typedParameter?: boolean } = {},
): string {
  const parameter = options.typedParameter ? "fn: Function" : "fn";
  return [
    `function ${helperName}(${parameter}) {`,
    "  Object.freeze(fn);",
    "  const prototype = fn.prototype;",
    '  if (prototype && typeof prototype === "object") {',
    "    Object.freeze(prototype);",
    "  }",
    "  return fn;",
    "}",
  ].join("\n");
}

export function createBindingIdentityHelperSource(
  helperName = BINDING_IDENTITY_HELPER_NAME,
  metadataField = VERIFIED_BINDING_METADATA_FIELD,
  options: { typedParameter?: boolean } = {},
): string {
  const parameter = options.typedParameter ? "value: any" : "value";
  const metadataParameter = options.typedParameter
    ? "metadata: any"
    : "metadata";
  return [
    `function ${helperName}(${parameter}, ${metadataParameter}) {`,
    '  if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {',
    "    Object.defineProperty(value, " +
    JSON.stringify(metadataField) +
    ", {",
    "      value: metadata,",
    "      configurable: true",
    "    });",
    "  }",
    '  if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {',
    "    var implementation = value.implementation;",
    '    if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {',
    "      Object.defineProperty(implementation, " +
    JSON.stringify(metadataField) +
    ", {",
    "        value: metadata,",
    "        configurable: true",
    "      });",
    "    }",
    "  }",
    "  return value;",
    "}",
  ].join("\n");
}
