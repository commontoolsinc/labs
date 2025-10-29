import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe("LogicalAndNonJsx", (_state) => {
    const user = cell<{
        name: string;
        age: number;
    } | null>(null);
    return {
        [UI]: (<div>
        {/* Non-JSX right side: string template with complex expression */}
        <p>{__ctHelpers.when(__ctHelpers.derive(user.name, _v1 => _v1.length > 0), `Hello, ${user.name}!`)}</p>

        {/* Non-JSX right side: number expression */}
        <p>Age: {__ctHelpers.when(__ctHelpers.derive(user.age, _v1 => _v1 > 18), user.age)}</p>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
