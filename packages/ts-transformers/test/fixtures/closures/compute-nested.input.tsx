/// <cts-enable />
import { cell, compute, recipe } from "commontools";

export default recipe(() => {
  const a = cell(10);
  const b = cell(20);

  const sum = compute(() => a.get() + b.get());
  const doubled = compute(() => sum.get() * 2);

  return doubled;
});
