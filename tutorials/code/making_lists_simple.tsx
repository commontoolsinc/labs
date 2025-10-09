/// <cts-enable />
import {
  cell,
  h,
  recipe,
  UI,
} from "commontools";

export default recipe("making lists - simple", () => {
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
            <li>{name}</li>
          ))}
        </ul>
      </div>
    ),
  };
});
