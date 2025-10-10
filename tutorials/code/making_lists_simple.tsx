/// <cts-enable />
import { Default, h, recipe, UI } from "commontools";

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

export default recipe<FriendListState>("making lists - simple", (state) => {
  return {
    [UI]: (
      <div>
        <h2>My Friends</h2>
        <ul>
          {state.names.map((friend) => <li>{friend.name}</li>)}
        </ul>
      </div>
    ),
    names: state.names,
  };
});
