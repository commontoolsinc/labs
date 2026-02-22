/// <cts-enable />
/**
 * Test case for nested map transformation inside ternary.
 *
 * The key scenario: `item.tags.map(...)` where `item` is from an outer
 * `mapWithPattern` callback, and the whole thing is inside a ternary
 * that gets wrapped in `ifElse` → `derive`.
 *
 * The inner map on `item.tags` should still be transformed to
 * `mapWithPattern` because `item` comes from a mapWithPattern element,
 * NOT from the derive's captures.
 */
import { Cell, computed, Default, pattern, UI } from "commontools";

interface Tag {
  name: string;
}

interface Item {
  label: string;
  tags: Tag[];
  selectedIndex: number;
}

interface PatternInput {
  items?: Cell<Default<Item[], []>>;
}

export default pattern<PatternInput>(({ items }) => {
  const hasItems = computed(() => items && items.get().length > 0);

  return {
    [UI]: (
      <div>
        {hasItems ? (
          items!.map((item) => (
            <div>
              <strong>{item.label}</strong>
              <ul>
                {item.tags.map((tag, i) => (
                  <li>
                    {i === item.selectedIndex ? "* " : ""}
                    {tag.name}
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p>No items</p>
        )}
      </div>
    ),
  };
});
