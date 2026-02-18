/// <cts-enable />
import { Cell, derive, pattern, UI } from "commontools";

interface Item {
  name: string;
  done: Cell<boolean>;
}

interface Assignment {
  aisle: string;
  item: Item;
}

// CT-1036: Property access on derived grouped objects with derived keys
// This pattern groups items by a property, then maps over the group keys
// and accesses the grouped object with each key.
export default pattern<{ items: Item[] }>(
  ({ items }) => {
    // Create assignments with aisle data
    const itemsWithAisles = derive({ items }, ({ items }) =>
      items.map((item, idx) => ({
        aisle: `Aisle ${(idx % 3) + 1}`,
        item: item,
      }))
    );

    // Group by aisle - returns Record<string, Assignment[]>
    const groupedByAisle = derive({ itemsWithAisles }, ({ itemsWithAisles }) => {
      const groups: Record<string, Assignment[]> = {};
      for (const assignment of itemsWithAisles) {
        if (!groups[assignment.aisle]) {
          groups[assignment.aisle] = [];
        }
        groups[assignment.aisle]!.push(assignment);
      }
      return groups;
    });

    // Derive sorted aisle names from grouped object
    const aisleNames = derive({ groupedByAisle }, ({ groupedByAisle }) =>
      Object.keys(groupedByAisle).sort()
    );

    // The pattern from CT-1036:
    // - Map over derived keys (aisleNames)
    // - Access derived object with derived key (groupedByAisle[aisleName])
    // - Map over the result
    return {
      [UI]: (
        <div>
          {aisleNames.map((aisleName) => (
            <div>
              <h3>{aisleName}</h3>
              {(groupedByAisle[aisleName]! ?? []).map((assignment) => (
                <div>
                  <span>{assignment.item.name}</span>
                  <ct-checkbox $checked={assignment.item.done} />
                </div>
              ))}
            </div>
          ))}
        </div>
      ),
    };
  },
);
