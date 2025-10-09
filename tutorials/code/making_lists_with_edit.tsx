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

const editItem = handler<any, { names: Cell<string[]>, index: number }>(
  (event, { names, index }) => {
    if (event?.key === "Enter") {
      const newValue = event?.target?.value;
      if (newValue !== undefined) {
        const currentNames = names.get();
        names.set(currentNames.toSpliced(index, 1, newValue));
      }
    }
  },
);

export default recipe("making lists - with edit", () => {
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
            <li>
              <input
                value={name}
                onkeydown={editItem({ names, index })}
              />
              <button onclick={removeItem({ names, index })}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>
    ),
  };
});
