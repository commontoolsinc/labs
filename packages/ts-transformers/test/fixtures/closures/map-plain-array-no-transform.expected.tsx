import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface State {
    multiplier: number;
}
export default recipe({
    type: "object",
    properties: {
        multiplier: {
            type: "number"
        }
    },
    required: ["multiplier"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    const plainArray = [1, 2, 3, 4, 5];
    return {
        [UI]: (<div>
        {/* Plain array should NOT be transformed, even with captures */}
        {plainArray.map((n) => (<span>{__ctHelpers.derive({
                n: n,
                state: {
                    multiplier: state.multiplier
                }
            }, ({ n, state }) => n * state.multiplier)}</span>))}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
