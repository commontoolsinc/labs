/// <cts-enable />
import { type Cell, cell, h, handler, recipe, UI } from "commontools";

const removeItem = handler<
  unknown,
  { names: Cell<{ name: string }[]>; friend: { name: string } }
>(
  (_, { names, friend }) => {
    // Get the current array from the cell
    const currentNames = names.get();

    // Filter out the friend to remove. Here's how the comparison works:
    // 1. names.key(i) returns a Cell reference to the array element at index i
    // 2. friend is a proxy object from .map() that has a Symbol("toCell") function attached
    // 3. When .equals() is called, it invokes friend[Symbol("toCell")]() to convert
    //    the friend object back into a Cell reference
    // 4. The two Cell references are compared - they match if they point to the same
    //    underlying data (same Cell ID and path)
    const filtered = currentNames.filter((f, i) =>
      !names.key(i).equals(friend as any)
    );

    names.set(filtered);
  },
);

export default recipe("making lists - with remove", () => {
  const names = cell<{ name: string }[]>([]);

  // Initialize with 5 hardcoded names
  names.set([
    { name: "Alice" },
    { name: "Bob" },
    { name: "Charlie" },
    { name: "Diana" },
    { name: "Evan" },
  ]);

  return {
    [UI]: (
      <div>
        <h2>My Friends</h2>
        <ul>
          {names.map((friend) => (
            <li onclick={removeItem({ names, friend })}>
              {friend.name}
            </li>
          ))}
        </ul>
      </div>
    ),
  };
});
