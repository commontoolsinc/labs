/// <cts-enable />
import { Default, recipe, UI } from "commontools";

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
          {/* Note: key is not needed for Common Tools but linters require it */}
          {state.names.map((friend, index) => (
            <li key={index}>{friend.name}</li>
          ))}
        </ul>
      </div>
    ),
    names: state.names,
  };
});
