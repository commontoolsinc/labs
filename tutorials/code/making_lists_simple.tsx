/// <cts-enable />
import { cell, h, recipe, UI } from "commontools";

export default recipe("making lists - simple", () => {
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
          {names.map((friend) => <li>{friend.name}</li>)}
        </ul>
      </div>
    ),
  };
});
