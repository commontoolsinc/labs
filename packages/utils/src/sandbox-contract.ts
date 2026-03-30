export const SHADOWED_FACTORY_BINDINGS = [
  "define",
  "runtimeDeps",
  "__ctAmdHooks",
] as const;

export const FUNCTION_HARDENING_HELPER_NAME = "__ctHardenFn";

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
