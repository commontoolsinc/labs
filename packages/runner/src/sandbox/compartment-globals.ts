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
  return {
    console,
    harden,
    __ctHelpers: helpers,
    Proxy: undefined,
    fetch: undefined,
    Temporal: undefined,
    structuredClone: undefined,
  };
}
