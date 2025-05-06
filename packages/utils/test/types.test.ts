import { describe, it } from "@std/testing/bdd";
import { Mutable } from "@commontools/utils/types";

type ImmutableObj<T> = {
  readonly prop: T;
};

function mutate<T>(value: T, callback: (v: Mutable<T>) => void) {
  callback(value as Mutable<T>);
}

describe("types", () => {
  describe("Mutable", () => {
    it("Enables mutation on nested `{ readonly prop: T }`", () => {
      const schema: ImmutableObj<ImmutableObj<number>> = { prop: { prop: 5 } };
      mutate(schema, (schema) => {
        schema.prop.prop = 10;
      });
    });
    it("Enables mutation on nested `Readonly<T>`", () => {
      const schema: Readonly<{
        prop: Readonly<{
          prop: number;
        }>;
      }> = { prop: { prop: 5 } };
      mutate(schema, (schema) => {
        schema.prop.prop = 10;
      });
    });
    it("Enables mutation on `ReadonlyArray`", () => {
      const schema: ReadonlyArray<number> = [1, 2, 3];
      mutate(schema, (schema) => {
        schema[1] = 100;
      });
    });
    it("Enables mutation on `readonly T[]`", () => {
      const schema: readonly number[] = [1, 2, 3];
      mutate(schema, (schema) => {
        schema[1] = 100;
      });
    });
    it("Enables mutation on `ReadonlyArray` nested in `Readonly<T>`", () => {
      const schema: Readonly<{
        prop: ReadonlyArray<number>;
      }> = { prop: [1, 2, 3] };
      mutate(schema, (schema) => {
        schema.prop[1] = 100;
      });
    });
    it("Passes through for primitive types", () => {
      const _: Mutable<null> = null;
      const __: Mutable<number> = 5;
      const ___: Mutable<string> = "hi";
    });
  });
});
