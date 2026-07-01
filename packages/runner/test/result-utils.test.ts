import { expect } from "@std/expect";
import { setPatternCell } from "../src/result-utils.ts";
import type { Cell } from "../src/cell.ts";

Deno.test("setPatternCell copies parent pattern metadata when present", () => {
  const calls: unknown[][] = [];
  const resultCell = {
    setMetaRaw: (...args: unknown[]) => calls.push(args),
  } as unknown as Cell<unknown>;
  const parentPattern = { "/": "pattern-link" };
  const patternCell = {
    getRaw: () => parentPattern,
  } as unknown as Cell<unknown>;

  setPatternCell(resultCell, patternCell);

  expect(calls).toEqual([["pattern", parentPattern]]);
});
