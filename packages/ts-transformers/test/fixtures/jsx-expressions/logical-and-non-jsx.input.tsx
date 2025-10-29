/// <cts-enable />
import { cell, recipe, UI } from "commontools";

export default recipe("LogicalAndNonJsx", (_state) => {
  const user = cell<{ name: string; age: number } | null>(null);

  return {
    [UI]: (
      <div>
        {/* Non-JSX right side: string template with complex expression */}
        <p>{user.name.length > 0 && `Hello, ${user.name}!`}</p>

        {/* Non-JSX right side: number expression */}
        <p>Age: {user.age > 18 && user.age}</p>
      </div>
    ),
  };
});
