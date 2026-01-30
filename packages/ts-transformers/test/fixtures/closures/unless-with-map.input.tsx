/// <cts-enable />
/**
 * Test case for unless() with a reactive array map as the fallback.
 *
 * unless(condition, fallback) returns condition if truthy, else fallback.
 * When fallback is items.map(...), the map gets transformed to mapWithPattern.
 * Schema injection needs to know the type of the mapWithPattern result.
 */
import { Cell, Default, pattern, UI } from "commontools";

interface Item {
  label: string;
}

interface PatternInput {
  customContent: Cell<any>;
  items: Cell<Default<Item[], []>>;
}

export default pattern<PatternInput>(({ customContent, items }) => {
  return {
    [UI]: (
      <div>
        {/* unless(condition, fallback) where fallback is a reactive map */}
        {customContent || items.map((item) => <li>{item.label}</li>)}
      </div>
    ),
  };
});
