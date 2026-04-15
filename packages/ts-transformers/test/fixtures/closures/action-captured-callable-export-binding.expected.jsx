function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { action } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: action-captured-callable-export-binding
// Verifies: action() should not route captured plain callables through handler state
//   makeAction(helper) where helper is a closed-over callable should preserve lexical helper
//   access in the handler body instead of destructuring/passing helper through handler params.
// Context: the exported action binding form is later rejected by the plain-data/SES path, but
// this fixture isolates the earlier closure-transform shape in --show-transformed output.
function makeAction(helper: (value: string) => string) {
    return __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {}
    } as const satisfies __cfHelpers.JSONSchema, (_, __cf_action_params) => {
        return helper("x");
    })({});
}
__cfHardenFn(makeAction);
const helper = __cfHardenFn((value: string) => value.toUpperCase());
const myAction = __cfHelpers.__cf_data(makeAction(helper).for({ stream: "myAction" }, true));
export default myAction;
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
