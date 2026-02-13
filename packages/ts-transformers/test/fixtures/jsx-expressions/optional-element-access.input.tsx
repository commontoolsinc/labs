/// <cts-enable />
import { cell, NAME, pattern, UI } from "commontools";

export default pattern("Optional Element Access", () => {
  const list = cell<string[] | undefined>(undefined);
  return {
    [NAME]: "Optional element access",
    [UI]: (
      <div>
        {!list.get()?.[0] && <span>No first entry</span>}
      </div>
    ),
  };
});
