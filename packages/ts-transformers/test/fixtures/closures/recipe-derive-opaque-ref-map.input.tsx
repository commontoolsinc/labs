/// <cts-enable />
import { derive, recipe } from "commontools";

export default recipe<number[]>((items) => {
  // items is OpaqueRef<number[]> as a recipe parameter
  // Inside the derive callback, items.map should NOT be transformed
  const doubled = derive({}, () => items.map((n) => n * 2));
  return doubled;
});
