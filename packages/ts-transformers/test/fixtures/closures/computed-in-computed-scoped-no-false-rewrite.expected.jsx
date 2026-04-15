function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfModuleCallback_1 = __cfHardenFn(() => {
    const condition = 1 > 0;
    if (condition) {
        const config = __cfHelpers.derive({
            type: "object",
            properties: {}
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "object",
            properties: {
                bar: {
                    type: "number"
                }
            },
            required: ["bar"]
        } as const satisfies __cfHelpers.JSONSchema, {}, () => ({ bar: 1 })).for("config", true);
        return config.bar;
    }
    return config.bar;
});
const config = __cfHelpers.__cf_data({ bar: "module-level" });
// FIXTURE: computed-in-computed-scoped-no-false-rewrite
// Verifies: a block-scoped computed() result named `config` does NOT cause
//   the module-level `config.bar` to be rewritten to `config.key("bar")`.
//   The inner `config.bar` (block-scoped OpaqueRef) should be rewritten,
//   but the outer `config.bar` (plain object) must remain untouched.
// Context: The pre-scan collects opaque roots by name; it must not leak
//   across lexical scopes and incorrectly rewrite unrelated same-named accesses.
export default pattern(() => {
    const outer = __cfHelpers.derive({
        type: "object",
        properties: {}
    } as const satisfies __cfHelpers.JSONSchema, {
        type: ["number", "string"]
    } as const satisfies __cfHelpers.JSONSchema, {}, __cfModuleCallback_1).for("outer", true);
    return outer;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "string"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
