import { FrozenMap, FrozenSet } from "@commontools/memory/frozen-builtins";

export interface ModuleSafeRecord {
  readonly [key: string]: ModuleSafeValue;
  readonly [key: symbol]: ModuleSafeValue;
}

export type ModuleSafeValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | bigint
  | readonly ModuleSafeValue[]
  | ModuleSafeRecord
  | ReadonlyMap<ModuleSafeValue, ModuleSafeValue>
  | ReadonlySet<ModuleSafeValue>;

const verifiedPlainData = new WeakSet<object>();

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
  validateModuleSafeValue(value, path, new WeakSet());
}

export function freezeVerifiedPlainData<T>(
  value: T,
): T {
  return freezeModuleSafeValue(value, "<root>", new WeakMap()) as T;
}

function validateModuleSafeValue(
  value: unknown,
  path: string,
  visited: WeakSet<object>,
): void {
  switch (typeof value) {
    case "undefined":
    case "boolean":
    case "number":
    case "string":
    case "bigint":
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
  if (verifiedPlainData.has(objectValue) || visited.has(objectValue)) {
    return;
  }
  visited.add(objectValue);

  try {
    if (Array.isArray(objectValue)) {
      validateOwnProperties(objectValue, path, visited, { skipLength: true });
      return;
    }

    const proto = Object.getPrototypeOf(objectValue);
    if (proto === Object.prototype || proto === null) {
      validateOwnProperties(objectValue, path, visited);
      return;
    }

    if (proto === Map.prototype || proto === FrozenMap.prototype) {
      validateMap(
        objectValue as ReadonlyMap<unknown, unknown>,
        path,
        visited,
      );
      validateOwnProperties(objectValue, path, visited);
      return;
    }

    if (proto === Set.prototype || proto === FrozenSet.prototype) {
      validateSet(objectValue as ReadonlySet<unknown>, path, visited);
      validateOwnProperties(objectValue, path, visited);
      return;
    }

    throw validationError(
      path,
      `Unsupported object prototype '${proto?.constructor?.name ?? "null"}'`,
    );
  } finally {
    visited.delete(objectValue);
  }
}

function validateOwnProperties(
  value: object,
  path: string,
  visited: WeakSet<object>,
  options: { skipLength?: boolean } = {},
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (options.skipLength && key === "length") continue;

    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      throw validationError(
        pathForKey(path, key),
        "Own property descriptor is missing",
      );
    }

    validateModuleSafeValue(
      Reflect.get(value, key),
      pathForKey(path, key),
      visited,
    );
  }
}

function validateMap(
  value: ReadonlyMap<unknown, unknown>,
  path: string,
  visited: WeakSet<object>,
): void {
  let index = 0;
  for (
    const [key, entryValue] of Map.prototype.entries.call(
      value as Map<unknown, unknown>,
    )
  ) {
    validateModuleSafeValue(
      key,
      `${path}<map-key:${index}>`,
      visited,
    );
    validateModuleSafeValue(
      entryValue,
      `${path}<map-value:${index}>`,
      visited,
    );
    index += 1;
  }
}

function validateSet(
  value: ReadonlySet<unknown>,
  path: string,
  visited: WeakSet<object>,
): void {
  let index = 0;
  for (const entryValue of Set.prototype.values.call(value as Set<unknown>)) {
    validateModuleSafeValue(
      entryValue,
      `${path}<set:${index}>`,
      visited,
    );
    index += 1;
  }
}

function freezeModuleSafeValue(
  value: unknown,
  path: string,
  converted: WeakMap<object, ModuleSafeValue>,
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
  if (verifiedPlainData.has(objectValue)) {
    return objectValue as ModuleSafeValue;
  }

  const existing = converted.get(objectValue);
  if (existing !== undefined) {
    return existing;
  }

  if (Array.isArray(objectValue)) {
    return freezeArray(objectValue, path, converted);
  }

  const proto = Object.getPrototypeOf(objectValue);
  if (proto === Object.prototype || proto === null) {
    return freezeObject(objectValue, path, converted);
  }

  if (proto === Map.prototype || proto === FrozenMap.prototype) {
    return freezeMap(
      objectValue as ReadonlyMap<unknown, unknown>,
      path,
      converted,
    );
  }

  if (proto === Set.prototype || proto === FrozenSet.prototype) {
    return freezeSet(
      objectValue as ReadonlySet<unknown>,
      path,
      converted,
    );
  }

  throw validationError(
    path,
    `Unsupported object prototype '${proto?.constructor?.name ?? "null"}'`,
  );
}

function freezeArray(
  value: unknown[],
  path: string,
  converted: WeakMap<object, ModuleSafeValue>,
): readonly ModuleSafeValue[] {
  const result = new Array(value.length) as ModuleSafeValue[];
  converted.set(value, result as unknown as ModuleSafeValue);

  copyOwnProperties(value, result, path, converted, { skipLength: true });

  Object.freeze(result);
  verifiedPlainData.add(result);
  return result;
}

function freezeObject(
  value: object,
  path: string,
  converted: WeakMap<object, ModuleSafeValue>,
): ModuleSafeRecord {
  const result = Object.create(
    Object.getPrototypeOf(value),
  ) as ModuleSafeRecord;
  converted.set(value, result as ModuleSafeValue);

  copyOwnProperties(value, result, path, converted);

  Object.freeze(result);
  verifiedPlainData.add(result as object);
  return result;
}

function freezeMap(
  value: ReadonlyMap<unknown, unknown>,
  path: string,
  converted: WeakMap<object, ModuleSafeValue>,
): ReadonlyMap<ModuleSafeValue, ModuleSafeValue> {
  const result = new Map<ModuleSafeValue, ModuleSafeValue>();
  Object.setPrototypeOf(result, FrozenMap.prototype);
  converted.set(value as object, result as unknown as ModuleSafeValue);

  let index = 0;
  for (
    const [key, entryValue] of Map.prototype.entries.call(
      value as Map<unknown, unknown>,
    )
  ) {
    Map.prototype.set.call(
      result,
      freezeModuleSafeValue(
        key,
        `${path}<map-key:${index}>`,
        converted,
      ),
      freezeModuleSafeValue(
        entryValue,
        `${path}<map-value:${index}>`,
        converted,
      ),
    );
    index += 1;
  }

  copyOwnProperties(value as object, result, path, converted);

  Object.freeze(result);
  verifiedPlainData.add(result);
  return result;
}

function freezeSet(
  value: ReadonlySet<unknown>,
  path: string,
  converted: WeakMap<object, ModuleSafeValue>,
): ReadonlySet<ModuleSafeValue> {
  const result = new Set<ModuleSafeValue>();
  Object.setPrototypeOf(result, FrozenSet.prototype);
  converted.set(value as object, result as unknown as ModuleSafeValue);

  let index = 0;
  for (const entryValue of Set.prototype.values.call(value as Set<unknown>)) {
    Set.prototype.add.call(
      result,
      freezeModuleSafeValue(
        entryValue,
        `${path}<set:${index}>`,
        converted,
      ),
    );
    index += 1;
  }

  copyOwnProperties(value as object, result, path, converted);

  Object.freeze(result);
  verifiedPlainData.add(result);
  return result;
}

function copyOwnProperties(
  source: object,
  target: object,
  path: string,
  converted: WeakMap<object, ModuleSafeValue>,
  options: { skipLength?: boolean } = {},
): void {
  for (const key of Reflect.ownKeys(source)) {
    if (options.skipLength && key === "length") continue;

    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    if (!descriptor) {
      throw validationError(
        pathForKey(path, key),
        "Own property descriptor is missing",
      );
    }

    defineSnapshotProperty(
      target,
      key,
      freezeModuleSafeValue(
        Reflect.get(source, key),
        pathForKey(path, key),
        converted,
      ),
      descriptor.enumerable ?? true,
    );
  }
}

function defineSnapshotProperty(
  target: object,
  key: PropertyKey,
  value: ModuleSafeValue,
  enumerable: boolean,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable,
    configurable: true,
    writable: true,
  });
}

function pathForKey(
  path: string,
  key: PropertyKey,
): string {
  if (typeof key === "symbol") {
    return `${path}[${String(key)}]`;
  }

  const keyString = String(key);
  const index = Number(keyString);
  if (Number.isInteger(index) && String(index) === keyString) {
    return pathForIndex(path, index);
  }

  return pathForProperty(path, keyString);
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
