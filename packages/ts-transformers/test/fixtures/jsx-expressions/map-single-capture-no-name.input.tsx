/// <cts-enable />
import { cell, recipe, UI } from "commontools";

export default recipe((_state: any) => {
  const people = cell([
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
  ]);

  return {
    [UI]: (
      <div>
        {people.get().length > 0 && (
          <ul>
            {people.get().map((person) => (
              <li key={person.id}>{person.name}</li>
            ))}
          </ul>
        )}
      </div>
    ),
  };
});
