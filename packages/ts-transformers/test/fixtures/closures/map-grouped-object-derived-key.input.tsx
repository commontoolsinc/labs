/// <cts-enable />
import { derive, recipe, UI } from "commontools";

interface Item {
  id: string;
  category: string;
  done: boolean;
}

interface State {
  items: Item[];
}

export default recipe<State>("MapGroupedObjectDerivedKey", (state) => {
  // Group items by category
  const groupedByCategory = derive(state.items, (items) => {
    const groups: Record<string, Item[]> = {};
    for (const item of items) {
      if (!groups[item.category]) groups[item.category] = [];
      groups[item.category].push(item);
    }
    return groups;
  });

  // Get sorted category names
  const categoryNames = derive(groupedByCategory, (groups) =>
    Object.keys(groups).sort()
  );

  return {
    [UI]: (
      <div>
        {categoryNames.map((categoryName, idx) => (
          <div key={idx}>
            <h3>{categoryName}</h3>
            {/* Access grouped object with derived key - this should work with frame ancestry checking */}
            {(groupedByCategory[categoryName] ?? []).map((item, itemIdx) => (
              <div key={itemIdx}>
                {item.done ? "✓" : "○"} {item.id}
              </div>
            ))}
          </div>
        ))}
      </div>
    ),
  };
});
