/// <cts-enable />
import { type Cell, Default, h, handler, recipe, UI } from "commontools";

interface FriendListState {
  names: Default<
    { name: string }[],
    [
      { name: "Alice" },
      { name: "Bob" },
      { name: "Charlie" },
      { name: "Diana" },
      { name: "Evan" },
    ]
  >;
}

const removeItem = handler<
  unknown,
  { names: Cell<{ name: string }[]>; friend: { name: string } }
>(
  // TODO(@ellyxir): note this code SHOULD work but there's a bug
  // in the current system, so we have an alternative right below it
  // that is quite ugly but reconstructs the list without celllinks and symbols
  // (_, { names, friend }) => {
  //   const currentNames = names.get();
  //   const filtered = currentNames.filter((f, i) =>
  //     !names.key(i).equals(friend as any)
  //   );
  //   names.set(filtered);
  // },
  (_, { names, friend }) => {
    const currentNames = names.get();
    const filtered = currentNames.reduce((acc, _, i) => {
      if (!names.key(i).equals(friend as any)) {
        acc.push({ name: currentNames[i].name });
      }
      return acc;
    }, [] as { name: string }[]);
    names.set(filtered);
  },
);

export default recipe<FriendListState>(
  "making lists - with remove",
  (state) => {
    return {
      [UI]: (
        <div>
          <h2>My Friends</h2>
          <ul>
            {state.names.map((friend) => (
              <li onclick={removeItem({ names: state.names, friend })}>
                {friend.name}
              </li>
            ))}
          </ul>
        </div>
      ),
      names: state.names,
    };
  },
);
