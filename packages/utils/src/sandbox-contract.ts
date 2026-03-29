export const SHADOWED_FACTORY_BINDINGS = [
  "define",
  "runtimeDeps",
  "__ctAmdHooks",
] as const;

export const RESERVED_FACTORY_BINDINGS = [
  ...SHADOWED_FACTORY_BINDINGS,
] as const;

export function createFactoryShadowGuardSource(): string[] {
  return SHADOWED_FACTORY_BINDINGS.map((name) => `const ${name} = undefined;`);
}
