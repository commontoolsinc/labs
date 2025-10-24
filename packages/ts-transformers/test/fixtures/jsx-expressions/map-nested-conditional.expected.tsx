import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe("MapNestedConditional", (_state) => {
    const items = cell([{ name: "apple" }, { name: "banana" }]);
    const showList = cell(true);
    return {
        [UI]: (<div>
        {__ctHelpers.derive({ showList, items, item_name: item.name }, ({ showList: showList, items: items, item_name: _v3 }) => showList && (<div>
            {items.map((item) => (<div>
                {__ctHelpers.derive(_v3, _v3 => _v3 && <span>{_v3}</span>)}
              </div>))}
          </div>))}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
