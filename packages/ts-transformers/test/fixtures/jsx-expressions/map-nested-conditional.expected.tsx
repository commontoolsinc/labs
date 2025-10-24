import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe("MapNestedConditional", (_state) => {
    const items = cell([{ name: "apple" }, { name: "banana" }]);
    const showList = cell(true);
    return {
        [UI]: (<div>
        {__ctHelpers.derive({ showList, items }, ({ showList: showList, items: items }) => showList && (<div>
            {items.map((item) => (<div>
                {__ctHelpers.derive(item.name, _v1 => _v1 && <span>{_v1}</span>)}
              </div>))}
          </div>))}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
