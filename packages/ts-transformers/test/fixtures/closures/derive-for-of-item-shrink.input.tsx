/// <cts-enable />
import { derive, pattern, UI, NAME } from "commontools";

interface Item {
  name: string;
  category: string;
  price: number;
}

// FIXTURE: derive-for-of-item-shrink
// Verifies: derive() callback with for...of loop does NOT mark the iterable
//   as wildcard.  The capability analysis correctly identifies item-level
//   property access paths (["items", "name"]) via loop variable aliasing.
// Context: for-of aliasing enables future item-level schema shrinking.
//   Current reactive type wrappers (OpaqueCell) limit effective narrowing
//   at the schema level, but the capability paths are correct.
export default pattern<{ items: Item[] }>(({ items }) => {
  const names = derive({ items }, ({ items }) => {
    const result: string[] = [];
    for (const item of items) {
      result.push(item.name);
    }
    return result;
  });

  return {
    [NAME]: "test",
    [UI]: <div>{names}</div>,
  };
});
