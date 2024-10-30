import {
  OpaqueRef,
  OpaqueRefMethods,
  Value,
  NodeRef,
  NodeFactory,
  isOpaqueRefMarker,
  Frame,
  ShadowRef,
} from "./types.js";
import { setValueAtPath, hasValueAtPath } from "./utils.js";
import { getTopFrame, recipe } from "./recipe.js";
import { createNodeFactory } from "./module.js";

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
export function opaqueRef<T>(value?: Value<T> | T): OpaqueRef<T> {
  const store = {
    value,
    defaultValue: undefined,
    nodes: new Set<NodeRef>(),
    frame: getTopFrame(),
  };

  function createNestedProxy(
    path: PropertyKey[],
    target?: any
  ): OpaqueRef<any> {
    const methods: OpaqueRefMethods<any> = {
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
      connect: (node: NodeRef) => store.nodes.add(node),
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
      [isOpaqueRefMarker]: true,
    };

    const proxy = new Proxy(target || {}, {
      get(_, prop) {
        if (typeof prop === "symbol") {
          return methods[prop as keyof OpaqueRefMethods<any>];
        } else if (prop in methods) {
          return createNestedProxy(
            [...path, prop],
            methods[prop as keyof OpaqueRefMethods<any>]
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

  const top = createNestedProxy([]) as OpaqueRef<T>;
  return top;
}

export function createShadowRef(ref: OpaqueRef<any>, frame?: Frame): ShadowRef {
  console.log("createShadowRef");
  const refFrame = ref.export().frame;
  if (!refFrame || !frame || !frame.parent)
    throw new Error("Can't create shadow ref for non-parent ref");
  const shadowRef = {
    shadowOf:
      frame.parent === refFrame ? ref : createShadowRef(ref, frame.parent),
  };
  frame.shadows.push(shadowRef);
  return shadowRef;
}
