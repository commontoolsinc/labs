function createCompatibilityGlobals(): Record<string, unknown> {
  const globals: Record<string, unknown> = {};
  const hostGlobals = globalThis as typeof globalThis & Record<string, unknown>;

  if (typeof globalThis.fetch === "function") {
    // Temporary migration shim: many existing patterns still perform direct
    // network requests from authored callbacks.
    globals.fetch = globalThis.fetch.bind(globalThis);
  }

  for (
    const name of [
      "Headers",
      "Request",
      "Response",
      "URL",
      "URLSearchParams",
    ] as const
  ) {
    const value = hostGlobals[name];
    if (value !== undefined) {
      globals[name] = value;
    }
  }

  return globals;
}

export function createModuleCompartmentGlobals(
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...createCompatibilityGlobals(), ...extras };
}

export function createCallbackCompartmentGlobals(): Record<string, unknown> {
  return createCompatibilityGlobals();
}
