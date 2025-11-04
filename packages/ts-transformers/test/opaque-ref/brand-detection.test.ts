import { assert, assertEquals } from "@std/assert";
import {
  getCellKind,
  isOpaqueRefType,
} from "../../src/transformers/opaque-ref/opaque-ref.ts";
import { analyzeExpression } from "./harness.ts";

const PRELUDE = `
interface Cell<T> extends BrandedCell<T, "cell"> {}
interface Stream<T> extends BrandedCell<T, "stream"> {}
interface ComparableCell<T> extends BrandedCell<T, "comparable"> {}
interface ReadonlyCell<T> extends BrandedCell<T, "readonly"> {}
interface WriteonlyCell<T> extends BrandedCell<T, "writeonly"> {}

declare const cells: {
  cell: Cell<number>;
  stream: Stream<string>;
  comparable: ComparableCell<boolean>;
  readonly: ReadonlyCell<number>;
  writeonly: WriteonlyCell<number>;
};
`;

Deno.test("detects opaque brand", () => {
  const { checker, expression } = analyzeExpression("state.count");
  const type = checker.getTypeAtLocation(expression);
  assert(isOpaqueRefType(type, checker));
  assertEquals(getCellKind(type, checker), "opaque");
});

Deno.test("detects cell brand variants", () => {
  const variants: Array<[string, "cell" | "stream"]> = [
    ["cells.cell", "cell"],
    ["cells.comparable", "cell"],
    ["cells.readonly", "cell"],
    ["cells.writeonly", "cell"],
    ["cells.stream", "stream"],
  ];

  for (const [expr, expectedKind] of variants) {
    const { checker, expression } = analyzeExpression(expr, {
      prelude: PRELUDE,
    });
    const type = checker.getTypeAtLocation(expression);
    assert(isOpaqueRefType(type, checker), `${expr} should be treated as cell`);
    assertEquals(
      getCellKind(type, checker),
      expectedKind,
      `unexpected cell kind for ${expr}`,
    );
  }
});
