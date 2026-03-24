export function createModuleCompartmentGlobals(
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...extras };
}

export function createCallbackCompartmentGlobals(): Record<string, unknown> {
  return {};
}
