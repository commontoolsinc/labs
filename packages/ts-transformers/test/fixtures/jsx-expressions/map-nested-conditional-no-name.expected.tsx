import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe(true as const satisfies __ctHelpers.JSONSchema, (_state: any) => {
    const items = cell([{ name: "apple" }, { name: "banana" }]);
    const showList = cell(true);
    return {
        [UI]: (<div>
        {__ctHelpers.derive({
            showList: showList,
            items: items
        }, ({ showList, items }) => showList && (<div>
            {items.map((item) => (<div>
                {__ctHelpers.derive({ item: {
                    name: item.name
                } }, ({ item }) => item.name && <span>{item.name}</span>)}
              </div>))}
          </div>))}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
