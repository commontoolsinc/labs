/// <cts-enable />
import { cell, compute, recipe } from "commontools";

export default recipe<{ multiplier: number }, number>(({ multiplier }) => {
  const value = cell(10);
  const result = compute(() => value.get() * multiplier);
  return result;
});
