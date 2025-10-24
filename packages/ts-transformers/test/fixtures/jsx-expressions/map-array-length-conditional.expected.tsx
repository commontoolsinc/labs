import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe("MapArrayLengthConditional", (_state) => {
    const list = cell(["apple", "banana", "cherry"]);
    return {
        [UI]: (<div>
        {__ctHelpers.derive({ list, name }, ({ list: list, name: name }) => list.length > 0 && (<div>
            {list.map((name) => (<span>{name}</span>))}
          </div>))}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
