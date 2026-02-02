/// <cts-enable />
/**
 * Edge case: cell() with a .map() result as initial value.
 *
 * This tests the scenario where:
 * 1. ClosureTransformer transforms .map() to .mapWithPattern()
 * 2. SchemaInjectionTransformer needs to infer the value type from the input expression
 * 3. The input expression is now a synthetic mapWithPattern node
 *
 * Without proper typeRegistry lookup, the schema might fall back to `unknown`
 * because checker.getTypeAtLocation() doesn't know about synthetic nodes.
 */
import { Cell, cell, pattern } from "commontools";

interface Item {
  id: number;
  value: string;
}

export default pattern<{ items: Cell<Item[]> }>(({ items }) => {
  // items.map() will be transformed to items.mapWithPattern()
  // cell() needs to infer the type from this synthetic node
  const mappedCell = cell(items.map((item) => item.value));

  return { mappedCell };
});
