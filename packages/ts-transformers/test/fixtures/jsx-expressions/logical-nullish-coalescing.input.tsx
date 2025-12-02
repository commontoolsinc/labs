/// <cts-enable />
import { cell, recipe, UI } from "commontools";

// Tests nullish coalescing (??) interaction with && and ||
// ?? should NOT be transformed to when/unless (different semantics)
export default recipe("LogicalNullishCoalescing", (_state) => {
  const config = cell<{ timeout: number | null; retries: number | undefined }>({
    timeout: null,
    retries: undefined,
  });
  const items = cell<string[]>([]);

  return {
    [UI]: (
      <div>
        {/* ?? followed by || - different semantics */}
        <span>Timeout: {(config.timeout ?? 30) || "disabled"}</span>

        {/* ?? followed by && */}
        <span>{(config.retries ?? 3) > 0 && "Will retry"}</span>

        {/* Mixed: ?? with && and || */}
        <span>
          {items.length > 0 && (items[0] ?? "empty") || "no items"}
        </span>
      </div>
    ),
  };
});
