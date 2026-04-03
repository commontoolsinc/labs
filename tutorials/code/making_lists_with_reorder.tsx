/// <cts-enable />
import { type Cell, Default, handler, pattern, UI } from "commontools";

interface FriendListState {
  names: Default<string[], ["Alice", "Bob", "Charlie", "Diana", "Evan"]>;
  selectedIndex: Default<number, 0>;
}

const removeItem = handler<unknown, { names: Cell<string[]>; index: number }>(
  (_, { names, index }) => {
    const currentNames = names.get();
    names.set(currentNames.toSpliced(index, 1));
  },
);

const editItem = handler<any, { names: Cell<string[]>; index: number }>(
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

const selectItem = handler<
  unknown,
  { selectedIndex: Cell<number>; index: number }
>(
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
    [newNames[index], newNames[newIndex]] = [
      newNames[newIndex],
      newNames[index],
    ];
    names.set(newNames);
    selectedIndex.set(newIndex);
  }
});

export default pattern<FriendListState>(
  (state) => {
    return {
      [UI]: (
        <div>
          <h2>My Friends</h2>
          <p>Click to select, Ctrl+Up/Down to reorder</p>

          <ct-keybind
            ctrl
            key="ArrowUp"
            onct-keybind={moveItem({
              names: state.names,
              selectedIndex: state.selectedIndex,
              direction: "UP",
            })}
          />
          <ct-keybind
            ctrl
            key="ArrowDown"
            onct-keybind={moveItem({
              names: state.names,
              selectedIndex: state.selectedIndex,
              direction: "DOWN",
            })}
          />

          <ul>
            {/* Note: key is not needed for Common Tools but linters require it */}
            {state.names.map((name, index) => (
              <li
                key={index}
                onclick={selectItem({
                  selectedIndex: state.selectedIndex,
                  index,
                })}
              >
                <input
                  value={name}
                  onkeydown={editItem({ names: state.names, index })}
                />
                <button
                  type="button"
                  onclick={removeItem({ names: state.names, index })}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      ),
      names: state.names,
      selectedIndex: state.selectedIndex,
    };
  },
);
