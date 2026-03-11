/// <cts-enable />
import { cell, pattern, UI } from "commontools";

// FIXTURE: logical-and-non-jsx
// Verifies: && with non-JSX right side (string template, number) is wrapped in derive(), not when()
//   user.get().name.length > 0 && `Hello...` → derive({user}, ({user}) => user.get().name.length > 0 && `Hello...`)
//   user.get().age > 18 && user.get().age    → derive({user}, ...)
// Context: when() is only for JSX right-hand sides; non-JSX uses derive()
export default pattern((_state) => {
  const user = cell<{ name: string; age: number }>({ name: "", age: 0 });

  return {
    [UI]: (
      <div>
        {/* Non-JSX right side: string template with complex expression */}
        <p>{user.get().name.length > 0 && `Hello, ${user.get().name}!`}</p>

        {/* Non-JSX right side: number expression */}
        <p>Age: {user.get().age > 18 && user.get().age}</p>
      </div>
    ),
  };
});
