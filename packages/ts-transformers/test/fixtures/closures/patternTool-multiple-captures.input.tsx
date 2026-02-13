/// <cts-enable />
import { derive, patternTool, Writable } from "commontools";

const multiplier = Writable.of(2);
const prefix = Writable.of("Result: ");

const tool = patternTool(({ value }: { value: number }) => {
  return derive({ value }, ({ value }) => {
    return prefix.get() + String(value * multiplier.get());
  });
});

export default tool;
