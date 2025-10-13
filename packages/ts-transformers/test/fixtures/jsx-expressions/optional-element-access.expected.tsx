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
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
