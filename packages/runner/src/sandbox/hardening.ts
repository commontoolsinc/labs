// Prototypes that must NOT be frozen because they are shared with the host
// realm.  Freezing them would break host code that creates or mutates
// instances of these classes.
const BUILTIN_MUTABLE_PROTOTYPES: Set<object> = (() => {
  const set = new Set<object>([
    Object.prototype,
    Function.prototype,
    Array.prototype,
    Map.prototype,
    Set.prototype,
    RegExp.prototype,
    Promise.prototype,
  ]);

  // Web API constructors whose prototypes are exposed to compartment code via
  // compartment-globals.ts.  We must not freeze these host-realm prototypes.
  const hostGlobals = globalThis as Record<string, unknown>;
  for (
    const name of [
      "Headers",
      "Request",
      "Response",
      "TextDecoder",
      "TextEncoder",
      "URL",
      "URLSearchParams",
    ]
  ) {
    const ctor = hostGlobals[name];
    if (typeof ctor === "function" && ctor.prototype) {
      set.add(ctor.prototype as object);
    }
  }

  return set;
})();

export function freezeSandboxValue<T>(
  value: T,
  seen = new WeakSet<object>(),
): T {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return value;
  }
  seen.add(objectValue);

  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(objectValue, key);
    if (!descriptor || !("value" in descriptor)) {
      continue;
    }
    freezeSandboxValue(descriptor.value, seen);
  }

  if (typeof value === "function") {
    const prototype = (value as { prototype?: unknown }).prototype;
    if (prototype && typeof prototype === "object") {
      freezeSandboxValue(prototype, seen);
    }
  }

  const prototype = Object.getPrototypeOf(objectValue);
  if (
    prototype &&
    typeof prototype === "object" &&
    !BUILTIN_MUTABLE_PROTOTYPES.has(prototype)
  ) {
    freezeSandboxValue(prototype, seen);
  }

  Object.freeze(objectValue);
  return value;
}

export function freezeSandboxRecordValues<T extends Record<string, unknown>>(
  values: T,
): T {
  const entries = Object.entries(values).map(([key, value]) => [
    key,
    freezeSandboxValue(value),
  ]);
  return Object.fromEntries(entries) as T;
}
