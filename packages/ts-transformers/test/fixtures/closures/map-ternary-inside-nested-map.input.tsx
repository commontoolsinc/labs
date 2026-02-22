/// <cts-enable />
/**
 * Test case for ternary transformation inside nested Cell.map callbacks.
 *
 * The key scenario: A ternary inside a nested .map() callback should be
 * transformed to ifElse, because the callback body of a Cell.map is
 * back in "pattern mode" where ternaries need transformation.
 *
 * This structure mirrors pattern-nested-jsx-map: outer ternary wraps items.map,
 * causing ifElse → derive, then inner ternary is inside nested .map callback.
 */
import { Cell, computed, Default, pattern, UI } from "commontools";

interface Tag {
  name: string;
  active: boolean;
}

interface Item {
  label: string;
  tags: Tag[];
}

interface PatternInput {
  items?: Cell<Default<Item[], []>>;
  showInactive?: Default<boolean, false>;
}

export default pattern<PatternInput>(({ items, showInactive }) => {
  const hasItems = computed(() => items && items.get().length > 0);

  return {
    [UI]: (
      <div>
        {hasItems ? (
          items!.map((item) => (
            <div>
              {/* Ternary in outer map, outside inner map - should also be ifElse */}
              <strong>{item.tags.length > 0 ? item.label : "No tags"}</strong>
              <ul>
                {item.tags.map((tag) => (
                  <li>
                    {/* This ternary should be transformed to ifElse */}
                    {tag.active ? tag.name : showInactive ? `(${tag.name})` : ""}
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
