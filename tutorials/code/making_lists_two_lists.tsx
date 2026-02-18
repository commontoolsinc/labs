/// <cts-enable />
import { type Cell, Default, handler, pattern, UI } from "commontools";

interface FriendListsState {
  personalFriends: Default<
    { name: string }[],
    [
      { name: "Alice" },
      { name: "Bob" },
      { name: "Charlie" },
      { name: "David" },
      { name: "Emma" },
      { name: "Frank" },
      { name: "Grace" },
      { name: "Henry" },
      { name: "Iris" },
      { name: "Jack" },
    ]
  >;
  workFriends: Default<
    { name: string }[],
    [
      { name: "Kevin" },
      { name: "Laura" },
      { name: "Mike" },
      { name: "Nancy" },
      { name: "Oscar" },
      { name: "Paula" },
      { name: "Quinn" },
      { name: "Rachel" },
      { name: "Steve" },
      { name: "Tina" },
      { name: "Uma" },
      { name: "Victor" },
    ]
  >;
  selectedItem: Default<
    { which_list: "work" | "personal"; index: number } | null,
    null
  >;
}

const selectItem = handler<
  unknown,
  {
    selectedItem: Cell<
      { which_list: "work" | "personal"; index: number } | null
    >;
    which_list: "work" | "personal";
    index: number;
  }
>(
  (_, { selectedItem, which_list, index }) => {
    console.log("Selected:", which_list, index);
    selectedItem.set({ which_list, index });
  },
);

const moveItem = handler<
  any,
  {
    personalFriends: Cell<{ name: string }[]>;
    workFriends: Cell<{ name: string }[]>;
    selectedItem: Cell<
      { which_list: "work" | "personal"; index: number } | null
    >;
    direction: "UP" | "DOWN";
  }
>((event, { personalFriends, workFriends, selectedItem, direction }) => {
  console.log("moveItem triggered, event:", event, "direction:", direction);
  const selected = selectedItem.get();
  if (selected === null) return;

  const targetList = selected.which_list === "personal"
    ? personalFriends
    : workFriends;
  const currentNames = targetList.get();
  const offset = direction === "UP" ? -1 : 1;
  const newIndex = selected.index + offset;

  if (newIndex >= 0 && newIndex < currentNames.length) {
    // Reconstruct the array with swapped items
    const newNames = currentNames.reduce((acc, _, i) => {
      if (i === selected.index) {
        acc.push({ name: currentNames[newIndex].name });
      } else if (i === newIndex) {
        acc.push({ name: currentNames[selected.index].name });
      } else {
        acc.push({ name: currentNames[i].name });
      }
      return acc;
    }, [] as { name: string }[]);
    targetList.set(newNames);

    // Update selected index
    selectedItem.set({ which_list: selected.which_list, index: newIndex });
  }
});

const moveToList = handler<
  any,
  {
    personalFriends: Cell<{ name: string }[]>;
    workFriends: Cell<{ name: string }[]>;
    selectedItem: Cell<
      { which_list: "work" | "personal"; index: number } | null
    >;
    targetList: "work" | "personal";
  }
>(
  (
    event,
    { personalFriends, workFriends, selectedItem, targetList: target },
  ) => {
    console.log("moveToList triggered, event:", event, "target:", target);
    const selected = selectedItem.get();
    if (selected === null) return;

    // Don't move if already in target list
    if (selected.which_list === target) return;

    const sourceList = selected.which_list === "personal"
      ? personalFriends
      : workFriends;
    const destList = target === "personal" ? personalFriends : workFriends;

    const sourceNames = sourceList.get();
    const destNames = destList.get();

    // Get the item to move
    const itemToMove = sourceNames[selected.index];

    // Remove from source list
    const newSourceNames = sourceNames.reduce((acc, _, i) => {
      if (i !== selected.index) {
        acc.push({ name: sourceNames[i].name });
      }
      return acc;
    }, [] as { name: string }[]);
    sourceList.set(newSourceNames);

    // Add to destination list at the same index, or at the end if too small
    const targetIndex = Math.min(selected.index, destNames.length);
    const newDestNames: { name: string }[] = [];

    for (let i = 0; i < destNames.length; i++) {
      if (i === targetIndex) {
        newDestNames.push({ name: itemToMove.name });
      }
      newDestNames.push({ name: destNames[i].name });
    }

    // If targetIndex is at the end, append it
    if (targetIndex === destNames.length) {
      newDestNames.push({ name: itemToMove.name });
    }

    destList.set(newDestNames);

    // Update selection to new location
    selectedItem.set({ which_list: target, index: targetIndex });
  },
);

export default pattern<FriendListsState>(
  (state) => {
    const moveUpHandler = moveItem({
      personalFriends: state.personalFriends,
      workFriends: state.workFriends,
      selectedItem: state.selectedItem,
      direction: "UP",
    });
    const moveDownHandler = moveItem({
      personalFriends: state.personalFriends,
      workFriends: state.workFriends,
      selectedItem: state.selectedItem,
      direction: "DOWN",
    });
    const moveToPersonalHandler = moveToList({
      personalFriends: state.personalFriends,
      workFriends: state.workFriends,
      selectedItem: state.selectedItem,
      targetList: "personal",
    });
    const moveToWorkHandler = moveToList({
      personalFriends: state.personalFriends,
      workFriends: state.workFriends,
      selectedItem: state.selectedItem,
      targetList: "work",
    });

    return {
      [UI]: (
        <div>
          <h2>
            Click to select, Ctrl+Up/Down to reorder, Ctrl+Left/Right to move
            between lists
          </h2>

          <div style="margin-bottom: 1rem;">
            <button type="button" onclick={moveUpHandler}>
              ▲ Move Up
            </button>
            <button type="button" onclick={moveDownHandler}>
              ▼ Move Down
            </button>
            <button type="button" onclick={moveToPersonalHandler}>
              ◀ Move to Personal
            </button>
            <button type="button" onclick={moveToWorkHandler}>
              ▶ Move to Work
            </button>
          </div>

          <ct-keybind
            ctrl
            key="ArrowUp"
            onct-keybind={moveUpHandler}
          />
          <ct-keybind
            ctrl
            key="ArrowDown"
            onct-keybind={moveDownHandler}
          />
          <ct-keybind
            ctrl
            key="ArrowLeft"
            onct-keybind={moveToPersonalHandler}
          />
          <ct-keybind
            ctrl
            key="ArrowRight"
            onct-keybind={moveToWorkHandler}
          />

          <div style="display: flex; gap: 2rem;">
            <div>
              <h3>Personal Friends</h3>
              <ul>
                {/* Note: key is not needed for Common Tools but linters require it */}
                {state.personalFriends.map((friend, index) => (
                  <li
                    key={index}
                    onclick={selectItem({
                      selectedItem: state.selectedItem,
                      which_list: "personal",
                      index,
                    })}
                  >
                    {friend.name}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Work Friends</h3>
              <ul>
                {/* Note: key is not needed for Common Tools but linters require it */}
                {state.workFriends.map((friend, index) => (
                  <li
                    key={index}
                    onclick={selectItem({
                      selectedItem: state.selectedItem,
                      which_list: "work",
                      index,
                    })}
                  >
                    {friend.name}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ),
      personalFriends: state.personalFriends,
      workFriends: state.workFriends,
      selectedItem: state.selectedItem,
    };
  },
);
