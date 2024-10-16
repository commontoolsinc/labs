import {
  CellProxy,
  CellProxyMethods,
  Value,
  NodeProxy,
  NodeFactory,
  isCellProxyMarker,
} from "./types.js";
import { setValueAtPath, hasValueAtPath } from "./utils.js";
import { recipe } from "./recipe.js";
import { createNodeFactory } from "./module.js";

let mapFactory: NodeFactory<any, any>;

// A cell factory that creates a future cell with an optional default value.
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
export function cell<T>(value?: Value<T> | T): CellProxy<T> {
  const store = {
    value,
    defaultValue: undefined,
    nodes: new Set<NodeProxy>(),
  };

  function createNestedProxy(
    path: PropertyKey[],
    target?: any
  ): CellProxy<any> {
    const methods: CellProxyMethods<any> = {
      get: () => proxy,
      set: (newValue: Value<any>) => {
        setValueAtPath(store, ["value", ...path], newValue);
      },
      key: (key: PropertyKey) => createNestedProxy([...path, key]),
      setDefault: (newValue: Value<any>) => {
        if (!hasValueAtPath(store, ["defaultValue", ...path]))
          setValueAtPath(store, ["defaultValue", ...path], newValue);
      },
      setPreExisting: (ref: any) => setValueAtPath(store, ["external"], ref),
      connect: (node: NodeProxy) => store.nodes.add(node),
      export: () => ({
        cell: top,
        path,
        ...store,
      }),
      map: <S>(
        fn: (
          value: Value<Required<T extends Array<infer U> ? U : T>>
        ) => Value<S>
      ) => {
        // Create the factory if it doesn't exist. Doing it here to avoid
        // circular dependency.
        mapFactory ||= createNodeFactory({
          type: "ref",
          implementation: "map",
        });
        return mapFactory({
          list: proxy,
          op: recipe("mapping function", fn),
        });
      },
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
            if (index >= 50)
              throw new Error(
                "Can't use iterator over an opaque value in an unlimited loop."
              );
            return {
              done: false,
              value: createNestedProxy([...path, index++]),
            };
          },
        };
      },
      [isCellProxyMarker]: true,
    };

    const proxy = new Proxy(target || {}, {
      get(_, prop) {
        if (typeof prop === "symbol") {
          return methods[prop as keyof CellProxyMethods<any>];
        } else if (prop in methods) {
          return createNestedProxy(
            [...path, prop],
            methods[prop as keyof CellProxyMethods<any>]
          );
        } else return createNestedProxy([...path, prop]);
      },
      set(_, prop, value) {
        methods.set({ [prop]: value });
        return true;
      },
    });

    return proxy;
  }

  const top = createNestedProxy([]) as CellProxy<T>;
  return top;
}
