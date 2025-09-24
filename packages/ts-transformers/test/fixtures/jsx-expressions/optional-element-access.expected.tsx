/// <cts-enable />
import { cell, h, recipe, NAME, UI, derive } from "commontools";
export default recipe("Optional Element Access", () => {
    const list = cell<string[] | undefined>(undefined);
    return {
        [NAME]: "Optional element access",
        [UI]: (<div>
        {derive(list, list => !list?.[0] && <span>No first entry</span>)}
      </div>),
    };
});
