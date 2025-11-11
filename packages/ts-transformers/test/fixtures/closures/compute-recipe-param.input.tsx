/// <cts-enable />
import { cell, compute, recipe } from "commontools";

export default recipe((config: { multiplier: number }) => {
  const value = cell(10);
  const result = compute(() => value.get() * config.multiplier);
  return result;
});
