/// <cts-enable />
/**
 * Test case for when() with a reactive array map as the value.
 *
 * when(condition, value) returns value if condition is truthy, else condition.
 * When value is items.map(...), the map gets transformed to mapWithPattern.
 * Schema injection needs to know the type of the mapWithPattern result.
 */
import { Cell, Default, pattern, UI } from "commontools";

interface Item {
  label: string;
}

interface PatternInput {
  showItems: boolean;
  items: Cell<Default<Item[], []>>;
}

export default pattern<PatternInput>(({ showItems, items }) => {
  return {
    [UI]: (
      <div>
        {/* when(condition, value) where value is a reactive map */}
        {showItems && items.map((item) => <li>{item.label}</li>)}
      </div>
    ),
  };
});
