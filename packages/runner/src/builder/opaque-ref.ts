import { isRecord } from "@commontools/utils/types";
import {
  type IOpaqueCell,
  isOpaqueRefMarker,
  type JSONSchema,
  type NodeFactory,
  type NodeRef,
  type Opaque,
  type OpaqueCell,
  type OpaqueRef,
  type Recipe,
  type SchemaWithoutCell,
  type ShadowRef,
  type UnsafeBinding,
} from "./types.ts";
import { toOpaqueRef } from "../back-to-cell.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { hasValueAtPath, setValueAtPath } from "../path-utils.ts";
import { getTopFrame, recipe } from "./recipe.ts";
import { createNodeFactory } from "./module.ts";
import { createCell, type Cell } from "../cell.ts";
import type { IRuntime } from "../runtime.ts";

let mapFactory: NodeFactory<any, any> | undefined;

/**
 * Creates an opaqueRef factory bound to a runtime.
 * This allows opaqueRef to create actual Cells underneath instead of proxies.
 * @param runtime - The runtime to use for creating cells
 * @returns A factory function for creating OpaqueRefs
 */
export function createOpaqueRefFactory(runtime: IRuntime) {
  return function opaqueRef<T>(
    value?: Opaque<T> | T,
    schema?: JSONSchema,
  ): OpaqueRef<T> {
    const cfc = new ContextualFlowControl();

    // Create a Cell without a link - it will be created on demand via .for()
    const cell = createCell<T>(runtime, undefined, undefined, false);

    // If schema provided, apply it
    if (schema) {
      cell.setSchema(schema);
    }

    // Set initial value if provided (cast to any to avoid type issues with Opaque)
    if (value !== undefined) {
      cell.set(value as any);
    }

    // Store OpaqueRef-specific data that Cell doesn't track
    const opaqueStore = {
      defaultValue: undefined as Opaque<any> | undefined,
      name: undefined as string | undefined,
    };

    // Create a proxy wrapper that adds iterator and toPrimitive support
    const proxy = new Proxy(cell, {
      get(target, prop) {
        if (prop === Symbol.iterator) {
          // Iterator support for array destructuring
          return function* () {
            let index = 0;
            while (index < 50) { // Limit to 50 items like original
              const childSchema = cfc.getSchemaAtPath(schema, [
                index.toString(),
              ], schema);
              const childCell = (target as any).key(index);
              if (childSchema) {
                childCell.setSchema(childSchema);
              }
              yield childCell;
              index++;
            }
          };
        } else if (prop === Symbol.toPrimitive) {
          return () => {
            throw new Error(
              "Tried to directly access an opaque value. Use `derive` instead, passing this variable in as parameter to derive, not closing over it",
            );
          };
        } else if (prop === isOpaqueRefMarker) {
          return true;
        } else if (prop === "setName") {
          return (name: string) => {
            opaqueStore.name = name;
          };
        } else if (prop === "setDefault") {
          return (newValue: Opaque<any>) => {
            opaqueStore.defaultValue = newValue;
            // Also call Cell's setDefault (though it's deprecated)
            cell.setDefault(newValue);
          };
        } else if (prop === "export") {
          return () => {
            const cellExport = (target as any).export();
            return {
              ...cellExport,
              ...opaqueStore,
            };
          };
        }
        // Delegate everything else to the Cell
        return (target as any)[prop];
      },
    });

    return proxy as unknown as OpaqueRef<T>;
  };
}

// Legacy opaqueRef for backward compatibility - creates proxies without Cell
// This is used during recipe construction before we have a runtime
export function opaqueRef<S extends JSONSchema>(
  value: Opaque<SchemaWithoutCell<S>> | SchemaWithoutCell<S>,
  schema: S,
): OpaqueRef<SchemaWithoutCell<S>>;
export function opaqueRef<T>(
  value?: Opaque<T> | T,
  schema?: JSONSchema,
): OpaqueRef<T>;

export function opaqueRef<T>(
  value?: Opaque<T> | T,
  schema?: JSONSchema,
): OpaqueRef<T> {
  const store = {
    value,
    defaultValue: undefined,
    nodes: new Set<NodeRef>(),
    frame: getTopFrame()!,
    name: undefined as string | undefined,
    schema: schema,
  };

  let unsafe_binding: { recipe: Recipe; path: PropertyKey[] } | undefined;
  const cfc = new ContextualFlowControl();

  function createNestedProxy(
    path: PropertyKey[],
    target: any,
    nestedSchema: JSONSchema | undefined,
    rootSchema: JSONSchema | undefined,
  ): OpaqueRef<any> {
    // Create the methods object that implements IOpaqueCell
    // These methods are shared by both OpaqueRef and Cell, ensuring compatibility
    const methods: IOpaqueCell<T> = {
      get: () => unsafe_materialize(unsafe_binding, path) as T,
      set: (newValue: Opaque<any>) => {
        if (unsafe_binding) {
          unsafe_materialize(unsafe_binding, path); // TODO(seefeld): Set value
        } else setValueAtPath(store, ["value", ...path], newValue);
      },
      key: (key: PropertyKey) => {
        // Determine child schema when accessing a property
        const childSchema = key in methods
          ? undefined
          : cfc.getSchemaAtPath(nestedSchema, [key.toString()], rootSchema);
        return createNestedProxy(
          [...path, key],
          key in methods ? methods[key as keyof IOpaqueCell<T>] : store,
          childSchema,
          childSchema === undefined ? undefined : rootSchema,
        );
      },
      setDefault: (newValue: Opaque<any>) => {
        if (!hasValueAtPath(store, ["defaultValue", ...path])) {
          setValueAtPath(store, ["defaultValue", ...path], newValue);
        }
      },
      setPreExisting: (ref: any) => setValueAtPath(store, ["external"], ref),
      setName: (name: string) => {
        if (path.length === 0) store.name = name;
        else throw new Error("Can only set name for root opaque ref");
      },
      setSchema: (newSchema: JSONSchema) => {
        // This sets the schema of the nested proxy, but does not alter the parent store's
        // schema. Our schema variable shadows that one.
        nestedSchema = newSchema;
      },
      connect: (node: NodeRef) => store.nodes.add(node),
      export: () => {
        // Store's schema won't be the same as ours as a nested proxy
        // We also don't adjust the defaultValue to be relative to our path
        return {
          cell: top as OpaqueCell<T>,
          ...store,
          path,
          rootSchema,
          schema: nestedSchema,
        };
      },
      unsafe_bindToRecipeAndPath: (
        recipe: Recipe,
        path: PropertyKey[],
      ) => (unsafe_binding = { recipe, path }),
      unsafe_getExternal: () => {
        if (!unsafe_binding) return proxy;
        const value = unsafe_materialize(unsafe_binding, path);
        if (
          isRecord(value) && value[toOpaqueRef] &&
          typeof value[toOpaqueRef] === "function"
        ) {
          return (value[toOpaqueRef] as () => OpaqueRef<any>)();
        } else return proxy;
      },
      map: <S>(
        fn: (
          element: T extends Array<infer U> ? OpaqueRef<U> : OpaqueRef<T>,
          index: OpaqueRef<number>,
          array: OpaqueRef<T>,
        ) => Opaque<S>,
      ): OpaqueRef<S[]> => {
        // Create the factory if it doesn't exist. Doing it here to avoid
        // circular dependency.
        mapFactory ||= createNodeFactory({
          type: "ref",
          implementation: "map",
        });
        return mapFactory({
          list: proxy,
          op: recipe(
            ({ element, index, array }: Opaque<any>) =>
              fn(element, index, array),
          ),
        });
      },
      mapWithPattern: <S>(
        op: Recipe,
        params: Record<string, any>,
      ) => {
        // Create the factory if it doesn't exist. Doing it here to avoid
        // circular dependency.
        mapFactory ||= createNodeFactory({
          type: "ref",
          implementation: "map",
        });
        return mapFactory({
          list: proxy,
          op: op,
          params: params,
        });
      },
      toJSON: () => null, // Return null for OpaqueRef without links (matches Cell behavior)
      /**
       * We assume the cell is an array and will provide an infinite iterator.
       * The primary use-case is destructuring a tuple (`[a, b] = ...`). We
       * hence limit to at most 50 items, which should be enough for that, but
       * prevents infinite loops if used elsewhere.
       */
      [Symbol.iterator]: () => {
        let index = 0;
        return {
          next: () => {
            if (index >= 50) {
              throw new Error(
                "Can't use iterator over an opaque value in an unlimited loop.",
              );
            }
            const childSchema = cfc.getSchemaAtPath(nestedSchema, [
              index.toString(),
            ], rootSchema);
            return {
              done: false,
              value: createNestedProxy(
                [...path, index++],
                target,
                childSchema,
                childSchema === undefined ? undefined : rootSchema,
              ),
            };
          },
        };
      },
      // unsafe way to materialize opaque references at runtime
      [Symbol.toPrimitive]: (hint: string) => {
        const value = unsafe_materialize(unsafe_binding, path);
        return value?.[Symbol.toPrimitive]?.(hint) ?? value;
      },
      [isOpaqueRefMarker]: true,
    };

    const proxy = new Proxy(target || {}, {
      get(_, prop) {
        if (typeof prop === "symbol") {
          return methods[prop as keyof IOpaqueCell<T>];
        } else {
          return (methods as unknown as OpaqueCell<unknown>).key(prop);
        }
      },
      set(_, prop, value) {
        methods.set({ [prop]: value } as Opaque<Partial<T>>);
        return true;
      },
    });

    return proxy;
  }

  const top = createNestedProxy([], store, schema, schema) as OpaqueRef<T>;

  store.frame.opaqueRefs.add(top);

  return top;
}

export function stream<T>(): OpaqueRef<T> {
  return opaqueRef<T>({ $stream: true } as T);
}

export function createShadowRef(ref: OpaqueRef<any>): ShadowRef {
  return { shadowOf: ref };
}

function unsafe_materialize(
  _binding: { recipe: Recipe; path: PropertyKey[] } | undefined,
  _path: PropertyKey[],
): any {
  throw new Error(
    "Tried to access closed over variable within derive or lift. Instead pass the variable as an argument to the recipe.",
  );
}
