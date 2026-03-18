import "ses";

let lockdownApplied = false;

export function ensureSESLockdown(): void {
  if (lockdownApplied) {
    return;
  }

  lockdown({
    errorTaming: "unsafe",
    consoleTaming: "unsafe",
    stackFiltering: "concise",
  });
  lockdownApplied = true;
}

export function createCompartmentGlobals(
  console: unknown,
  helpers: Record<string, unknown>,
): Record<string, unknown> {
  ensureSESLockdown();
  const hardenedHelpers = harden(helpers);
  return {
    console,
    harden,
    __ctHelpers: hardenedHelpers,
    Proxy: undefined,
    fetch: undefined,
    Temporal: undefined,
    structuredClone: undefined,
  };
}
