/// <cts-enable />
import { cell, h, recipe, NAME, UI } from "commontools";

export default recipe("Optional Element Access", () => {
  const list = cell<string[] | undefined>(undefined);
  return {
    [NAME]: "Optional element access",
    [UI]: (
      <div>
        {!list?.[0] && <span>No first entry</span>}
      </div>
    ),
  };
});
