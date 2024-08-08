import {
  CellProxy,
  CellProxyMethods,
  Value,
  NodeProxy,
  isCellProxyMarker,
} from "./types.js";
import { setValueAtPath, hasValueAtPath } from "./utils.js";

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
export function cell<T>(defaultValue?: Value<T> | T): CellProxy<T> {
  const store = {
    value: undefined,
    defaultValue,
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
      setDefault: (newValue: Value<any>) => {
        if (!hasValueAtPath(store, ["defaultValue", ...path]))
          setValueAtPath(store, ["defaultValue", ...path], newValue);
      },
      connect: (node: NodeProxy) => store.nodes.add(node),
      export: () => ({
        top,
        path,
        ...store,
      }),
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
