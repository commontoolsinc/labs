import { cell, derive, pattern, patternTool, type PatternToolResult } from "commonfabric";

const multiplier = cell(2);
const offset = cell(10);

type Output = {
  tool: PatternToolResult<{ offset: number }>;
};

// Test: patternTool with an existing extraParam, and a new capture
// The function has { value: number, offset: number } as input type
// We provide offset via extraParams, and the transformer should capture multiplier
// FIXTURE: patternTool-with-existing-params
// Verifies: patternTool merges auto-captured vars into pre-existing extraParams
//   patternTool(fn, { offset }) → patternTool(fn, { multiplier, offset })
//   callback signature gains captured param: ({ value, offset }) → ({ value, offset, multiplier })
// Context: `offset` is already provided as an explicit extraParam. The transformer
//   detects that `multiplier` (module-scoped cell) is also captured and merges it
//   into the existing extraParams without duplicating `offset`.
export default pattern<Record<string, never>, Output>(() => {
  const tool = patternTool(
    ({ value, offset }: { value: number; offset: number }) => {
      return derive({ value, offset }, ({ value, offset }) => {
        return value * multiplier.get() + offset;
      });
    },
    { offset },
  );

  return { tool };
});
