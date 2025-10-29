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
} & IDFields & Record<never, never>;

type InferKey<T, K extends PropertyKey> = T extends { [P in K]-?: infer V } ? V : never;

type Bad = InferKey<Obj, "nope">;

const _check: Bad extends never ? true : false = true;
