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

const selectItem = handler<unknown, { selectedIndex: Cell<number>, index: number }>(
  (_, { selectedIndex, index }) => {
    selectedIndex.set(index);
  },
);

const moveItem = handler<
  any,
  {
    names: Cell<string[]>;
    selectedIndex: Cell<number>;
    direction: "UP" | "DOWN";
  }
>((_, { names, selectedIndex, direction }) => {
    const index = selectedIndex.get();
    const currentNames = names.get();
    const offset = direction === "UP" ? -1 : 1;
    const newIndex = index + offset;

    if (newIndex >= 0 && newIndex < currentNames.length) {
      const newNames = [...currentNames];
      [newNames[index], newNames[newIndex]] = [newNames[newIndex], newNames[index]];
      names.set(newNames);
      selectedIndex.set(newIndex);
    }
  },
);

const addFriend = handler<any, { names: Cell<string[]> }>(
  (event, { names }) => {
    if (event?.key === "Enter") {
      const name = event?.target?.value?.trim();
      if (name) {
        const currentNames = names.get();
        names.set([...currentNames, name]);
      }
    }
  },
);

export default recipe("making lists - with add", () => {
  const names = cell<string[]>([]);
  const selectedIndex = cell<number>(0);

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
        <p>Click to select, Ctrl+Up/Down to reorder</p>

        <ct-keybind
          ctrl
          key="ArrowUp"
          onct-keybind={moveItem({ names, selectedIndex, direction: "UP" })}
        />
        <ct-keybind
          ctrl
          key="ArrowDown"
          onct-keybind={moveItem({ names, selectedIndex, direction: "DOWN" })}
        />

        <div>
          <input
            onkeydown={addFriend({ names })}
            placeholder="Add a new friend..."
          />
        </div>

        <ul>
          {names.map((name, index) => (
            <li onclick={selectItem({ selectedIndex, index })}>
              <input
                value={name}
                onkeydown={editItem({ names, index })}
              />
              <button type="button" onclick={removeItem({ names, index })}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>
    ),
  };
});
