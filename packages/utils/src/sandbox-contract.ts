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
    "handler",
    "lift",
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
