import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe("LogicalAndSimpleRef", (_state) => {
    const showPanel = cell(true);
    const userName = cell("Alice");
    return {
        [UI]: (<div>
        {/* Simple opaque ref - should NOT use when, just derive the whole expression */}
        {__ctHelpers.derive(showPanel, showPanel => showPanel && <div>Panel content</div>)}

        {/* Another simple ref */}
        {__ctHelpers.derive(userName, userName => userName && <span>Hello {userName}</span>)}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
