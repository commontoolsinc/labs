import { describe, it } from "@std/testing/bdd";
import type { Cell } from "commontools";
import type { KeyResultType, AsCell } from "commontools";

type IsSame<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

describe("KeyResultType", () => {
  it("preserves existing cell wrappers", () => {
    type Nested = { inner: Cell<number> };
    type Result = KeyResultType<Nested, "inner", AsCell>;

    const _check: IsSame<Result, Cell<number>> = true;
    void _check;
  });
});
