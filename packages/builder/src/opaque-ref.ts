import {
  isOpaqueRefMarker,
  type JSONSchema,
  type NodeFactory,
  type NodeRef,
  type Opaque,
  type OpaqueRef,
  type OpaqueRefMethods,
  type Recipe,
  type ShadowRef,
  toOpaqueRef,
  type UnsafeBinding,
} from "./types.ts";
import { hasValueAtPath, setValueAtPath } from "./utils.ts";
import { getTopFrame, recipe } from "./recipe.ts";
import { createNodeFactory } from "./module.ts";
import { SchemaWithoutCell } from "./schema-to-ts.ts";
import { ContextualFlowControl } from "../../runner/src/index.ts";

let mapFactory: NodeFactory<any, any>;

// A opaque ref factory that creates future cells with optional default values.
//
// It's a proxy object representing a future cell that will eventually be
// created. It supports nested values and .set(), .get() and .setDefault()
// methods.
// - .set(value) sets the value of the proxy cell. This must be a bound data
//   structure, and internally creates a data node.
// - .get() just returns the cell itself, a proxy for the cell carrying the
//   value.
// - .setDefault(value) sets the default value of the cell.
//
// The proxy yields another proxy for each nested value, but still allows the
// methods to be called. Setters just call .set() on the nested cell.
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
    const methods: OpaqueRefMethods<any> = {
      get: () => unsafe_materialize(unsafe_binding, path),
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
          key in methods ? methods[key as keyof OpaqueRefMethods<any>] : store,
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
        return { cell: top, ...store, path, rootSchema, schema: nestedSchema };
      },
      unsafe_bindToRecipeAndPath: (
        recipe: Recipe,
        path: PropertyKey[],
      ) => (unsafe_binding = { recipe, path }),
      unsafe_getExternal: () => {
        if (!unsafe_binding) return proxy;
        const value = unsafe_materialize(unsafe_binding, path);
        if (typeof value === "object" && value !== null && value[toOpaqueRef]) {
          return value[toOpaqueRef]();
        } else return proxy;
      },
      map: <S>(
        fn: (
          element: Opaque<Required<T extends Array<infer U> ? U : T>>,
          index: Opaque<number>,
          array: T,
        ) => Opaque<S>,
      ) => {
        // Create the factory if it doesn't exist. Doing it here to avoid
        // circular dependency.
        mapFactory ||= createNodeFactory({
          type: "ref",
          implementation: "map",
        });
        return mapFactory({
          list: proxy,
          op: recipe(
            "mapping function",
            ({ element, index, array }: Opaque<any>) =>
              fn(element, index, array),
          ),
        });
      },
      toJSON: () => null, // TODO(seefeld): Merge with Cell and cover doc-less case
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
          return methods[prop as keyof OpaqueRefMethods<any>];
        } else {
          return methods.key(prop);
        }
      },
      set(_, prop, value) {
        methods.set({ [prop]: value });
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
  binding: { recipe: Recipe; path: PropertyKey[] } | undefined,
  path: PropertyKey[],
) {
  if (!binding) throw new Error("Can't read value during recipe creation.");

  // Find first frame with unsafe binding
  let frame = getTopFrame();
  let unsafe_binding: UnsafeBinding | undefined;
  while (frame && !unsafe_binding) {
    unsafe_binding = frame.unsafe_binding;
    frame = frame.parent;
  }

  // Walk up the chain until we find the original recipe
  while (unsafe_binding && unsafe_binding.parent?.recipe === binding.recipe) {
    unsafe_binding = unsafe_binding.parent;
  }

  if (!unsafe_binding) throw new Error("Can't find recipe in parent frames.");

  return unsafe_binding.materialize([...binding.path, ...path]);
}
