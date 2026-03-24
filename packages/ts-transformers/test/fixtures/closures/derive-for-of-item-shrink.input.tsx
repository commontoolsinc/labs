/// <cts-enable />
import { derive, pattern, UI, NAME } from "commontools";

interface Item {
  name: string;
  category: string;
  price: number;
}

// FIXTURE: derive-for-of-item-shrink
// Verifies: derive() callbacks using for...of can shrink array item schemas to
//   only the item properties that are actually read.
// Context: after OpaqueRef became transparent at the type level, iterating an
//   Item[] and only reading item.name should emit an input schema that narrows
//   items to { name: string }[] rather than keeping the full Item surface.
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
