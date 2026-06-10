import { Cell, computed, pattern } from "commonfabric";

// Runtime behaviour of carrying an `unknown`-typed value across a computed
// capture boundary by capturing a Cell<unknown> handle and reading it back with
// `.get()`.
//
// The capture schema is `{ type: "unknown", asCell: true }`. On read, the runner
// (runner/src/traverse.ts) treats the unknown element schema by value shape: a
// primitive passes through `traversePrimitive`, while an object or array
// short-circuits to `undefined` (`valid === TypeValidity.Unknown`). So the
// primitive survives and the structured payload is dropped — which is why the
// unknown-capture diagnostic warns on Cell<unknown> captures rather than treating
// `asCell` as safe.

interface Payload {
  name: string;
  list: number[];
  nested: { ok: boolean };
}

export default pattern<
  Record<string, never>,
  {
    prim: number;
    present: boolean;
    name: string;
    list: number[];
    nestedOk: boolean;
  }
>(() => {
  const primBox = Cell.of<unknown>(42);
  const structBox = Cell.of<unknown>(
    { name: "Alice", list: [1, 2, 3], nested: { ok: true } } as Payload,
  );

  return computed(() => {
    const p = primBox.get() as number;
    const s = structBox.get() as Payload | undefined;
    return {
      prim: p,
      present: s !== undefined && s !== null,
      name: s ? s.name : "MISSING",
      list: s ? s.list : [],
      nestedOk: s ? s.nested.ok : false,
    };
  });
});
