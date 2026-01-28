/// <cts-enable />
import { cell, derive, patternTool } from "commontools";

const multiplier = cell(2);
const offset = cell(10);

// Test: patternTool with an existing extraParam, and a new capture
// The function has { value: number, offset: number } as input type
// We provide offset via extraParams, and the transformer should capture multiplier
const tool = patternTool(
  ({ value, offset }: { value: number; offset: number }) => {
    return derive({ value, offset }, ({ value, offset }) => {
      return value * multiplier.get() + offset;
    });
  },
  { offset }
);

export default tool;
