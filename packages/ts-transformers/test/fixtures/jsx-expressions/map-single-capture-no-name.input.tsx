/// <cts-enable />
import { cell, pattern, UI } from "commontools";

export default pattern((_state: any) => {
  const people = cell([
    { id: "1", name: "Alice" },
    { id: "2", name: "Bob" },
  ]);

  return {
    [UI]: (
      <div>
        {people.get().length > 0 && (
          <ul>
            {people.map((person, index) => (
              <li key={index}>{person.name}</li>
            ))}
          </ul>
        )}
      </div>
    ),
  };
});
