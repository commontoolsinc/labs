import { hashSchema, internSchema } from "@commonfabric/data-model/schema-hash";
import { schemaWithProperties } from "@commonfabric/data-model/schema-utils";
import type { FabricValue } from "@commonfabric/memory/interface";
import type {
  Result,
  SchemaPathSelector,
  Unit,
} from "@commonfabric/memory/interface";
import { isDeepFrozen } from "@commonfabric/data-model/deep-freeze";
import { isRecord } from "@commonfabric/utils/types";
import type { JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { BaseMemoryAddress, MapSetStringToStrings } from "../traverse.ts";
import * as Address from "./transaction/address.ts";

const toKey = ({ id, scope }: BaseMemoryAddress) =>
  `${scope ?? "space"}\0${id}`;
const fromKey = (key: string): BaseMemoryAddress => {
  const separator = key.indexOf("\0");
  if (separator === -1) {
    return {
      id: key as BaseMemoryAddress["id"],
      type: "application/json",
    };
  }
  return {
    scope: key.slice(0, separator) as BaseMemoryAddress["scope"],
    id: key.slice(separator + 1) as BaseMemoryAddress["id"],
    type: "application/json",
  };
};

// Only cache against already-deep-frozen inputs. Mutable schemas can be edited
// in place, and keying the cache by their identity would return stale results.
const standardizedSchemaCache = new WeakMap<object, JSONSchema>();

const selectorRefFor = (selector: SchemaPathSelector): string =>
  JSON.stringify([
    selector.path,
    selector.schema === undefined
      ? ""
      : hashSchema(SelectorTracker.getStandardSchema(selector.schema)),
  ]);

// This class helps us maintain a client model of our server side subscriptions.
export class SelectorTracker<T = Result<Unit, Error>> {
  private refTracker = new MapSetStringToStrings();
  private selectors = new Map<string, SchemaPathSelector>();
  private standardizedSelector = new Map<string, SchemaPathSelector>();
  private selectorPromises = new Map<string, Promise<T>>();

  add(
    address: BaseMemoryAddress,
    selector: SchemaPathSelector,
    promise: Promise<T>,
  ) {
    if (selector === undefined || selector.schema === undefined) {
      return;
    }
    const selectorRef = selectorRefFor(selector);
    this.refTracker.add(toKey(address), selectorRef);
    this.selectors.set(selectorRef, selector);
    this.standardizedSelector.set(selectorRef, {
      path: selector.path,
      schema: SelectorTracker.getStandardSchema(selector.schema),
    });
    const promiseKey = `${toKey(address)}?${selectorRef}`;
    this.selectorPromises.set(promiseKey, promise);
  }

  has(address: BaseMemoryAddress): boolean {
    return this.refTracker.has(toKey(address));
  }

  hasSelector(
    address: BaseMemoryAddress,
    selector: SchemaPathSelector,
  ): boolean {
    const selectorRefs = this.refTracker.get(toKey(address));
    if (selectorRefs !== undefined) {
      const selectorRef = selectorRefFor(selector);
      return selectorRefs.has(selectorRef);
    }
    return false;
  }

  getSupersetSelector(
    address: BaseMemoryAddress,
    selector: SchemaPathSelector,
    cfc: ContextualFlowControl,
  ): [SchemaPathSelector?, Promise<T>?] {
    const selectorRefs = this.refTracker.get(toKey(address));
    const noMatch: [SchemaPathSelector?, Promise<T>?] = [undefined, undefined];
    if (selectorRefs === undefined) {
      return noMatch;
    }
    const newSelectorRef = selectorRefFor(selector);
    if (selectorRefs.has(newSelectorRef)) {
      const promiseKey = `${toKey(address)}?${newSelectorRef}`;
      return [
        this.standardizedSelector.get(newSelectorRef)!,
        this.selectorPromises.get(promiseKey)!,
      ];
    }
    const newAddress = { ...address, path: selector.path };
    const newSchema = selector.schema
      ? SelectorTracker.getStandardSchema(selector.schema)
      : false;
    const newSchemaHash = newSchema === false ? false : hashSchema(newSchema);
    for (const selectorRef of selectorRefs) {
      const existingSelector = this.standardizedSelector.get(selectorRef)!;
      const existingAddress = { ...address, path: existingSelector.path };
      if (Address.includes(existingAddress, newAddress)) {
        const existingSchema = existingSelector.schema;
        if (existingSchema === undefined) {
          continue;
        }
        const subPath = newAddress.path.slice(existingAddress.path.length);
        const subSchema = cfc.schemaAtPath(
          existingSchema,
          subPath,
          undefined,
          false,
          false,
        );
        const sortedSubSchema = SelectorTracker.getStandardSchema(subSchema);
        const sortedSubSchemaHash = typeof sortedSubSchema === "boolean"
          ? sortedSubSchema
          : hashSchema(sortedSubSchema);
        if (
          ContextualFlowControl.isTrueSchema(subSchema) ||
          sortedSubSchemaHash === newSchemaHash ||
          SelectorTracker.checkAnyOf(subSchema, newSchemaHash) ||
          newSchema === false
        ) {
          const promiseKey = `${toKey(address)}?${selectorRef}`;
          return [existingSelector, this.selectorPromises.get(promiseKey)!];
        } else {
          const newSchemaRefs = new Set<string>();
          ContextualFlowControl.findRefs(newSchema, newSchemaRefs);
          const newSchemaObj = isRecord(newSchema) ? newSchema : undefined;
          const sortedSubSchemaObj = isRecord(sortedSubSchema)
            ? sortedSubSchema
            : undefined;
          if (newSchemaObj && sortedSubSchemaObj && newSchemaRefs.size == 0) {
            const { $defs: _defs1, ...newSchemaNoDefsSpread } = newSchemaObj;
            const { $defs: _defs2, ...subSchemaNoDefsSpread } =
              sortedSubSchemaObj;
            const newSchemaNoDefs = internSchema(newSchemaNoDefsSpread);
            const subSchemaNoDefs = internSchema(subSchemaNoDefsSpread);
            if (
              hashSchema(
                SelectorTracker.getStandardSchema(subSchemaNoDefs),
              ) ===
                hashSchema(SelectorTracker.getStandardSchema(newSchemaNoDefs))
            ) {
              const promiseKey = `${toKey(address)}?${selectorRef}`;
              return [existingSelector, this.selectorPromises.get(promiseKey)!];
            }
          }
        }
      }
    }
    return noMatch;
  }

  get(address: BaseMemoryAddress): IteratorObject<SchemaPathSelector> {
    const selectorRefs = this.refTracker.get(toKey(address)) ?? [];
    return selectorRefs.values().map((selectorRef) =>
      this.selectors.get(selectorRef)!
    );
  }

  getPromise(
    address: BaseMemoryAddress,
    selector: SchemaPathSelector,
  ): Promise<T> | undefined {
    const selectorRef = selectorRefFor(selector);
    const promiseKey = `${toKey(address)}?${selectorRef}`;
    return this.selectorPromises.get(promiseKey);
  }

  delete(address: BaseMemoryAddress, selector: SchemaPathSelector): void {
    const selectorRef = selectorRefFor(selector);
    this.refTracker.deleteValue(toKey(address), selectorRef);
    const promiseKey = `${toKey(address)}?${selectorRef}`;
    this.selectorPromises.delete(promiseKey);
    if (![...this.refTracker].some(([, refs]) => refs.has(selectorRef))) {
      this.selectors.delete(selectorRef);
      this.standardizedSelector.delete(selectorRef);
    }
  }

  getAllPromises(): Iterable<Promise<T>> {
    return this.selectorPromises.values();
  }

  getAllSubscriptions(): {
    address: BaseMemoryAddress;
    selector: SchemaPathSelector;
  }[] {
    const subscriptions: {
      address: BaseMemoryAddress;
      selector: SchemaPathSelector;
    }[] = [];
    for (const [factKey, selectorRefs] of this.refTracker) {
      const address = fromKey(factKey);
      for (const selectorRef of selectorRefs) {
        const selector = this.selectors.get(selectorRef);
        if (selector) {
          subscriptions.push({ address, selector });
        }
      }
    }
    return subscriptions;
  }

  static checkAnyOf(
    schema: JSONSchema,
    schemaHash: string | false,
  ): boolean {
    return isRecord(schema) && Array.isArray(schema.anyOf) &&
      (schema.anyOf.some((item) => {
        item = SelectorTracker.getStandardSchema(item);
        if (hashSchema(item) === schemaHash) {
          return true;
        }
        if (schema.$defs !== undefined) {
          item = schemaWithProperties(item, {
            $defs: schema.$defs,
          });
          item = SelectorTracker.getStandardSchema(item);
          if (hashSchema(item) === schemaHash) {
            return true;
          }
        }
        if (item.$ref !== undefined) {
          item = ContextualFlowControl.resolveSchemaRefs(item, schema);
          item = SelectorTracker.getStandardSchema(item);
          return hashSchema(item) === schemaHash;
        }
        return false;
      }));
  }

  static getStandardSchema(schema: JSONSchema): JSONSchema {
    if (typeof schema === "boolean") {
      return schema;
    }
    const cacheable = isDeepFrozen(schema);
    if (cacheable) {
      const cached = standardizedSchemaCache.get(schema);
      if (cached !== undefined) {
        return cached;
      }
    }
    const traverse = (
      value: Readonly<any>,
    ): FabricValue => {
      if (isRecord(value)) {
        if (Array.isArray(value)) {
          return value.map((val) => traverse(val));
        } else {
          return Object.fromEntries(
            Object.entries(value).filter(([key, _val]) =>
              key !== "asCell" && key !== "asStream"
            ).sort(([keyA, _valA], [keyB, _valB]) =>
              keyA < keyB ? -1 : keyA > keyB ? 1 : 0
            ).map(([key, val]: [PropertyKey, any]) => [
              key.toString(),
              traverse(val),
            ]),
          );
        }
      } else return value;
    };
    const standardized = internSchema(traverse(schema) as JSONSchema);
    if (cacheable) {
      standardizedSchemaCache.set(schema, standardized);
    }
    return standardized;
  }
}
