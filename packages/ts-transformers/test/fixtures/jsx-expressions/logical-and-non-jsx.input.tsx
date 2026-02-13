/// <cts-enable />
import { cell, pattern, UI } from "commontools";

export default pattern("LogicalAndNonJsx", (_state) => {
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
