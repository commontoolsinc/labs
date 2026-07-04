import { expect } from "@std/expect";
import { setPatternCell } from "../src/result-utils.ts";

Deno.test("setPatternCell copies parent pattern metadata when present", () => {
  const calls: unknown[][] = [];
  const resultCell = {
    setMetaRaw: (...args: unknown[]) => calls.push(args),
  };
  const parentPattern = { "/": "pattern-link" };
  const patternCell = {
    getRaw: () => parentPattern,
  };

  setPatternCell(resultCell, patternCell);

  expect(calls).toEqual([["pattern", parentPattern]]);
});
