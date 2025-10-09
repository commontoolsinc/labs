/// <cts-enable />
import {
  cell,
  h,
  handler,
  recipe,
  UI,
  type Cell,
} from "commontools";

const removeItem = handler<unknown, { names: Cell<string[]>, index: number }>(
  (_, { names, index }) => {
    const currentNames = names.get();
    names.set(currentNames.toSpliced(index, 1));
  },
);

export default recipe("making lists - with remove", () => {
  const names = cell<string[]>([]);

  // Initialize with 5 hardcoded names
  names.set([
    "Alice",
    "Bob",
    "Charlie",
    "Diana",
    "Evan",
  ]);

  return {
    [UI]: (
      <div>
        <h2>My Friends</h2>
        <ul>
          {names.map((name, index) => (
            <li onclick={removeItem({ names, index })}>
              {name}
            </li>
          ))}
        </ul>
      </div>
    ),
  };
});
