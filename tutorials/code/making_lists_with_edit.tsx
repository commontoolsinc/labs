/// <cts-enable />
import { type Cell, Default, handler, pattern, UI } from "commontools";

interface FriendListState {
  names: Default<string[], ["Alice", "Bob", "Charlie", "Diana", "Evan"]>;
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

export default pattern<FriendListState>("making lists - with edit", (state) => {
  return {
    [UI]: (
      <div>
        <h2>My Friends</h2>
        <ul>
          {/* Note: key is not needed for Common Tools but linters require it */}
          {state.names.map((name, index) => (
            <li key={index}>
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
  };
});
