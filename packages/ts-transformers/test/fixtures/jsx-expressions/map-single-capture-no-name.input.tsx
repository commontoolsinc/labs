/// <cts-enable />
import { cell, recipe, UI } from "commontools";

export default recipe((_state: any) => {
  const people = cell([
    { id: "1", name: "Alice" },
    { id: "2", name: "Bob" },
  ]);

  // Convenience pattern: transformer wraps Cell access in derive() where value is unwrapped
  return {
    [UI]: (
      <div>
        {/* @ts-expect-error Testing convenience pattern: people is Cell, transformer wraps in derive */}
        {people.length > 0 && (
          <ul>
            {people.map((person) => (
              <li key={person.id}>{person.name}</li>
            ))}
          </ul>
        )}
      </div>
    ),
  };
});
