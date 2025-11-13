/// <cts-enable />
import { derive, pattern } from "commontools";

export default pattern<number[]>((items) => {
  // items is OpaqueRef<number[]> as a pattern parameter
  // Inside the derive callback, items.map should NOT be transformed
  const doubled = derive({}, () => items.map((n) => n * 2));
  return doubled;
});
