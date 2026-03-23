import { FrozenMap, FrozenSet } from "@commontools/memory/frozen-builtins";

export type ModuleSafeValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | bigint
  | readonly ModuleSafeValue[]
  | { readonly [key: string]: ModuleSafeValue }
  | ReadonlyMap<ModuleSafeValue, ModuleSafeValue>
  | ReadonlySet<ModuleSafeValue>;

const PROCESSING = Symbol("processing");

export class PlainDataValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "PlainDataValidationError";
  }
}

export function assertPlainData(
  value: unknown,
  path = "<root>",
): asserts value is ModuleSafeValue {
  validateModuleSafeValue(value, path, new WeakSet(), new WeakSet());
}

export function freezeVerifiedPlainData<T>(
  value: T,
): T {
  assertPlainData(value);
  return freezeModuleSafeValue(value, "<root>", new WeakMap()) as T;
}

function validateModuleSafeValue(
  value: unknown,
  path: string,
  active: WeakSet<object>,
  validated: WeakSet<object>,
): void {
  switch (typeof value) {
    case "undefined":
    case "boolean":
    case "string":
    case "bigint":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw validationError(path, "Non-finite numbers are not allowed");
      }
      return;
    case "object":
      if (value === null) return;
      break;
    default:
      throw validationError(
        path,
        `Unsupported value type '${typeof value}'`,
      );
  }

  const objectValue = value as object;
  if (validated.has(objectValue)) return;
  if (active.has(objectValue)) {
    throw validationError(path, "Circular references are not allowed");
  }

  active.add(objectValue);
  try {
    if (Array.isArray(objectValue)) {
      validateArray(objectValue, path, active, validated);
      return;
    }

    const proto = Object.getPrototypeOf(objectValue);
    if (proto === Object.prototype || proto === null) {
      validateObject(
        objectValue as Record<string, unknown>,
        path,
        active,
        validated,
      );
      return;
    }

    if (proto === Map.prototype || proto === FrozenMap.prototype) {
      validateMap(
        objectValue as ReadonlyMap<unknown, unknown>,
        path,
        active,
        validated,
      );
      return;
    }

    if (proto === Set.prototype || proto === FrozenSet.prototype) {
      validateSet(
        objectValue as ReadonlySet<unknown>,
        path,
        active,
        validated,
      );
      return;
    }

    throw validationError(
      path,
      `Unsupported object prototype '${proto?.constructor?.name ?? "null"}'`,
    );
  } finally {
    active.delete(objectValue);
    validated.add(objectValue);
  }
}

function validateArray(
  value: unknown[],
  path: string,
  active: WeakSet<object>,
  validated: WeakSet<object>,
): void {
  assertNoSymbolKeys(value, path);

  const names = Object.getOwnPropertyNames(value);
  const nameSet = new Set(names);

  if (!nameSet.has("length")) {
    throw validationError(path, "Array is missing its length property");
  }

  for (const name of names) {
    if (name === "length") continue;
    if (!isCanonicalArrayIndex(name, value.length)) {
      throw validationError(
        pathForProperty(path, name),
        "Arrays cannot have extra named properties",
      );
    }
  }

  for (let i = 0; i < value.length; i++) {
    const key = String(i);
    if (!nameSet.has(key)) {
      throw validationError(
        pathForIndex(path, i),
        "Sparse arrays are not allowed",
      );
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || isAccessorDescriptor(descriptor)) {
      throw validationError(
        pathForIndex(path, i),
        "Array elements must be data properties",
      );
    }
    if (!descriptor.enumerable) {
      throw validationError(
        pathForIndex(path, i),
        "Array elements must be enumerable",
      );
    }

    validateModuleSafeValue(
      descriptor.value,
      pathForIndex(path, i),
      active,
      validated,
    );
  }
}

function validateObject(
  value: Record<string, unknown>,
  path: string,
  active: WeakSet<object>,
  validated: WeakSet<object>,
): void {
  assertNoSymbolKeys(value, path);

  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || isAccessorDescriptor(descriptor)) {
      throw validationError(
        pathForProperty(path, name),
        "Object properties must be data properties",
      );
    }
    if (!descriptor.enumerable) {
      throw validationError(
        pathForProperty(path, name),
        "Object properties must be enumerable",
      );
    }

    validateModuleSafeValue(
      descriptor.value,
      pathForProperty(path, name),
      active,
      validated,
    );
  }
}

function validateMap(
  value: ReadonlyMap<unknown, unknown>,
  path: string,
  active: WeakSet<object>,
  validated: WeakSet<object>,
): void {
  assertCollectionHasNoOwnKeys(value, path);

  let index = 0;
  for (
    const [key, entryValue] of Map.prototype.entries.call(
      value as Map<unknown, unknown>,
    )
  ) {
    validateModuleSafeValue(
      key,
      `${path}<map-key:${index}>`,
      active,
      validated,
    );
    validateModuleSafeValue(
      entryValue,
      `${path}<map-value:${index}>`,
      active,
      validated,
    );
    index += 1;
  }
}

function validateSet(
  value: ReadonlySet<unknown>,
  path: string,
  active: WeakSet<object>,
  validated: WeakSet<object>,
): void {
  assertCollectionHasNoOwnKeys(value, path);

  let index = 0;
  for (const entryValue of Set.prototype.values.call(value as Set<unknown>)) {
    validateModuleSafeValue(
      entryValue,
      `${path}<set:${index}>`,
      active,
      validated,
    );
    index += 1;
  }
}

function freezeModuleSafeValue(
  value: unknown,
  path: string,
  converted: WeakMap<object, ModuleSafeValue | typeof PROCESSING>,
): ModuleSafeValue {
  switch (typeof value) {
    case "undefined":
    case "boolean":
    case "number":
    case "string":
    case "bigint":
      return value as ModuleSafeValue;
    case "object":
      if (value === null) return null;
      break;
    default:
      throw validationError(
        path,
        `Unsupported value type '${typeof value}'`,
      );
  }

  const objectValue = value as object;
  const existing = converted.get(objectValue);
  if (existing === PROCESSING) {
    throw validationError(path, "Circular references are not allowed");
  }
  if (existing !== undefined) {
    return existing;
  }

  converted.set(objectValue, PROCESSING);

  if (Array.isArray(objectValue)) {
    const result = freezeArray(objectValue, path, converted);
    converted.set(objectValue, result);
    return result;
  }

  const proto = Object.getPrototypeOf(objectValue);
  if (proto === Object.prototype || proto === null) {
    const result = freezeObject(
      objectValue as Record<string, unknown>,
      path,
      converted,
    );
    converted.set(objectValue, result);
    return result;
  }

  if (proto === Map.prototype || proto === FrozenMap.prototype) {
    const result = freezeMap(
      objectValue as ReadonlyMap<unknown, unknown>,
      path,
      converted,
    );
    converted.set(objectValue, result);
    return result;
  }

  if (proto === Set.prototype || proto === FrozenSet.prototype) {
    const result = freezeSet(
      objectValue as ReadonlySet<unknown>,
      path,
      converted,
    );
    converted.set(objectValue, result);
    return result;
  }

  throw validationError(
    path,
    `Unsupported object prototype '${proto?.constructor?.name ?? "null"}'`,
  );
}

function freezeArray(
  value: unknown[],
  path: string,
  converted: WeakMap<object, ModuleSafeValue | typeof PROCESSING>,
): readonly ModuleSafeValue[] {
  const isFrozen = Object.isFrozen(value);
  let result: ModuleSafeValue[] | undefined;

  for (let i = 0; i < value.length; i++) {
    const next = freezeModuleSafeValue(
      value[i],
      pathForIndex(path, i),
      converted,
    );
    if (!result && next !== value[i]) {
      result = isFrozen
        ? value.slice() as ModuleSafeValue[]
        : value as ModuleSafeValue[];
    }
    if (result) {
      result[i] = next;
    }
  }

  if (!result) {
    return isFrozen
      ? value as readonly ModuleSafeValue[]
      : Object.freeze(value as ModuleSafeValue[]);
  }
  return Object.freeze(result);
}

function freezeObject(
  value: Record<string, unknown>,
  path: string,
  converted: WeakMap<object, ModuleSafeValue | typeof PROCESSING>,
): { readonly [key: string]: ModuleSafeValue } {
  const proto = Object.getPrototypeOf(value);
  const isFrozen = Object.isFrozen(value);
  let result: Record<string, ModuleSafeValue> | undefined;
  let cloneDescriptors: PropertyDescriptorMap | undefined;

  for (const name of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor) continue;
    const next = freezeModuleSafeValue(
      value[name],
      pathForProperty(path, name),
      converted,
    );
    if (!result && next !== value[name]) {
      result = isFrozen
        ? Object.create(proto) as Record<string, ModuleSafeValue>
        : value as Record<string, ModuleSafeValue>;
      cloneDescriptors = isFrozen
        ? Object.getOwnPropertyDescriptors(value)
        : undefined;
    }
    if (result) {
      if (result === value) {
        result[name] = next;
      } else {
        cloneDescriptors![name] = {
          ...cloneDescriptors![name],
          value: next,
        };
      }
    }
  }

  if (!result) {
    return isFrozen
      ? value as { readonly [key: string]: ModuleSafeValue }
      : Object.freeze(value as Record<string, ModuleSafeValue>);
  }
  if (cloneDescriptors) {
    Object.defineProperties(result, cloneDescriptors);
  }
  return Object.freeze(result);
}

function freezeMap(
  value: ReadonlyMap<unknown, unknown>,
  path: string,
  converted: WeakMap<object, ModuleSafeValue | typeof PROCESSING>,
): ReadonlyMap<ModuleSafeValue, ModuleSafeValue> {
  const entries: Array<readonly [ModuleSafeValue, ModuleSafeValue]> = [];
  let changed = !(value instanceof FrozenMap);

  let index = 0;
  for (
    const [key, entryValue] of Map.prototype.entries.call(
      value as Map<unknown, unknown>,
    )
  ) {
    const nextKey = freezeModuleSafeValue(
      key,
      `${path}<map-key:${index}>`,
      converted,
    );
    const nextValue = freezeModuleSafeValue(
      entryValue,
      `${path}<map-value:${index}>`,
      converted,
    );
    changed ||= nextKey !== key || nextValue !== entryValue;
    entries.push([nextKey, nextValue]);
    index += 1;
  }

  if (!changed) return value as ReadonlyMap<ModuleSafeValue, ModuleSafeValue>;
  return new FrozenMap(entries);
}

function freezeSet(
  value: ReadonlySet<unknown>,
  path: string,
  converted: WeakMap<object, ModuleSafeValue | typeof PROCESSING>,
): ReadonlySet<ModuleSafeValue> {
  const entries: ModuleSafeValue[] = [];
  let changed = !(value instanceof FrozenSet);

  let index = 0;
  for (const entryValue of Set.prototype.values.call(value as Set<unknown>)) {
    const nextValue = freezeModuleSafeValue(
      entryValue,
      `${path}<set:${index}>`,
      converted,
    );
    changed ||= nextValue !== entryValue;
    entries.push(nextValue);
    index += 1;
  }

  if (!changed) return value as ReadonlySet<ModuleSafeValue>;
  return new FrozenSet(entries);
}

function assertNoSymbolKeys(
  value: object,
  path: string,
): void {
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
    throw validationError(path, "Symbol keys are not allowed");
  }
}

function assertCollectionHasNoOwnKeys(
  value: object,
  path: string,
): void {
  if (Reflect.ownKeys(value).length > 0) {
    throw validationError(
      path,
      "Collections cannot have extra own properties",
    );
  }
}

function isAccessorDescriptor(
  descriptor: PropertyDescriptor,
): boolean {
  return "get" in descriptor || "set" in descriptor;
}

function isCanonicalArrayIndex(
  name: string,
  length: number,
): boolean {
  const index = Number(name);
  return Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === name;
}

function pathForIndex(path: string, index: number): string {
  return `${path}[${index}]`;
}

function pathForProperty(path: string, name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `${path}.${name}`
    : `${path}[${JSON.stringify(name)}]`;
}

function validationError(
  path: string,
  message: string,
): PlainDataValidationError {
  return new PlainDataValidationError(path, message);
}
