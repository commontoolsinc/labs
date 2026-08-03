function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    layout: __cfHelpers.Writable<string>;
}, number>(({ layout }) => layout.get().trim().length, {
    type: "object",
    properties: {
        layout: {
            type: "string",
            asCell: ["readonly"]
        }
    },
    required: ["layout"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: cell-get-binding-autowrap
// Verifies: a bare `cell.get()` that feeds a computation at a variable-initializer
//   binding is auto-wrapped into a lift, the same way it is in a JSX expression.
//   Previously the validator rejected top-level cell .get() with
//   `pattern-context:get-call`; that restriction was legacy (the rewriter already
//   lowers the computation). A bare *terminal* `cell.get()` (no enclosing
//   computation) is still rejected elsewhere, since it has no lowerable site.
// Context: enabled migrating `cell.get()`-wrapped reads to drop the wrapper and
//   write a plain expression even when the input is a Writable/Cell.
export default pattern((__cf_pattern_input) => {
    const layout = __cf_pattern_input.key("layout");
    const len = __cfLift_1({ layout: layout }).for("len", true);
    return { len };
}, {
    type: "object",
    properties: {
        layout: {
            type: "string",
            asCell: ["cell"]
        }
    },
    required: ["layout"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        len: {
            type: "number"
        }
    },
    required: ["len"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
