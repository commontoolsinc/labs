import * as __ctHelpers from "commontools";
import { cell, h, recipe, NAME, UI } from "commontools";
export default recipe("Optional Element Access", () => {
    const list = cell<string[] | undefined>(undefined);
    return {
        [NAME]: "Optional element access",
        [UI]: (<div>
        {__ctHelpers.derive(list, list => !list?.[0] && <span>No first entry</span>)}
      </div>),
    };
});
__ctHelpers.NAME; // <internals>
