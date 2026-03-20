import "ses";

let lockdownApplied = false;
const originalStructuredClone = globalThis.structuredClone?.bind(globalThis);
const originalDate = globalThis.Date;
const originalDateNow = originalDate.now.bind(originalDate);
const originalDateParse = originalDate.parse.bind(originalDate);
const originalDateUTC = originalDate.UTC.bind(originalDate);
const originalMathDescriptors = Object.getOwnPropertyDescriptors(
  globalThis.Math,
);

function createDateEndowment(): DateConstructor {
  const DateEndowment = function (
    this: unknown,
    ...args: any[]
  ) {
    if (new.target) {
      return Reflect.construct(originalDate, args, new.target);
    }
    return (originalDate as (...values: any[]) => string)(...args);
  } as unknown as DateConstructor;

  Object.setPrototypeOf(DateEndowment, originalDate);
  Object.defineProperty(DateEndowment, "prototype", {
    value: originalDate.prototype,
  });
  Object.defineProperties(DateEndowment, {
    now: { value: originalDateNow },
    parse: { value: originalDateParse },
    UTC: { value: originalDateUTC },
  });

  return DateEndowment;
}

function createMathEndowment(): Math {
  return Object.defineProperties({}, originalMathDescriptors) as Math;
}

export function ensureSESLockdown(): void {
  if (lockdownApplied) {
    return;
  }

  lockdown({
    errorTaming: "unsafe",
    consoleTaming: "unsafe",
    reporting: "none",
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
    Date: createDateEndowment(),
    Math: createMathEndowment(),
    Proxy: undefined,
    fetch: undefined,
    Temporal: undefined,
    structuredClone: typeof originalStructuredClone === "function"
      ? originalStructuredClone
      : undefined,
  };
}
