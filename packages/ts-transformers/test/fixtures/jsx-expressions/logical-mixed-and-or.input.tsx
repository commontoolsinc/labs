/// <cts-enable />
import { cell, recipe, UI } from "commontools";

// Tests mixed && and || operators: (a && b) || c
// The && should use when, the || should use unless
export default recipe("LogicalMixedAndOr", (_state) => {
  const user = cell<{ name: string; age: number } | null>(null);
  const defaultMessage = cell("Guest");

  return {
    [UI]: (
      <div>
        {/* (condition && value) || fallback pattern */}
        <span>{(user.name.length > 0 && user.name) || defaultMessage}</span>

        {/* condition && (value || fallback) pattern */}
        <span>{user.age > 18 && (user.name || "Anonymous Adult")}</span>

        {/* Complex: (a && b) || (c && d) */}
        <span>
          {(user.name.length > 0 && `Hello ${user.name}`) ||
            (user.age > 0 && `Age: ${user.age}`) ||
            "Unknown user"}
        </span>
      </div>
    ),
  };
});
