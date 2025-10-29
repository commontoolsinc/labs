const ID: unique symbol = Symbol();
const ID_FIELD: unique symbol = Symbol();

type IDFields = {
  [ID]?: unknown;
  [ID_FIELD]?: unknown;
};

type Obj = {
  user: {
    profile: { name: string };
  };
} & IDFields;

type KeyValue<T, K extends PropertyKey> =
  ((x: T) => void) extends (x: infer R & Record<K, infer V>) => void ? V : never;

type Bad = KeyValue<Obj, "nope">;

const _check: Bad extends never ? true : false = true;
