/// <cts-enable />
/**
 * Edge case: derive with a .map() result as input, NO captures in derive callback,
 * and NO explicit type annotation on the callback parameter.
 *
 * This tests the scenario where:
 * 1. ClosureTransformer transforms .map() to .mapWithPattern()
 * 2. ClosureTransformer does NOT transform the derive (no captures)
 * 3. SchemaInjectionTransformer needs to infer the argument type from the input expression
 * 4. The input expression is now a synthetic mapWithPattern node
 *
 * Without proper typeRegistry lookup, the schema might fall back to `unknown`
 * because checker.getTypeAtLocation() doesn't know about synthetic nodes.
 */
import { Cell, derive, pattern } from "commontools";

interface Item {
  id: number;
  value: string;
}

export default pattern<{ items: Cell<Item[]> }>(({ items }) => {
  // items.map() will be transformed to items.mapWithPattern()
  // derive has NO captures, so it won't be transformed by ClosureTransformer
  // The callback param has NO explicit type annotation
  const count = derive(items.map((item) => item.value), (arr) => arr.length);

  return { count };
});
