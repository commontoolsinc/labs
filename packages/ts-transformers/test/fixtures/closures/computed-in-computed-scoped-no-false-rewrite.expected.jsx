import * as __ctHelpers from "commontools";
import { computed, pattern } from "commontools";
const config = { bar: "module-level" };
// FIXTURE: computed-in-computed-scoped-no-false-rewrite
// Verifies: a block-scoped computed() result named `config` does NOT cause
//   the module-level `config.bar` to be rewritten to `config.key("bar")`.
//   The inner `config.bar` (block-scoped OpaqueRef) should be rewritten,
//   but the outer `config.bar` (plain object) must remain untouched.
// Context: The pre-scan collects opaque roots by name; it must not leak
//   across lexical scopes and incorrectly rewrite unrelated same-named accesses.
export default pattern(() => {
    const outer = __ctHelpers.derive({
        type: "object",
        properties: {}
    } as const satisfies __ctHelpers.JSONSchema, {
        type: ["number", "string"]
    } as const satisfies __ctHelpers.JSONSchema, {}, () => {
        const condition = 1 > 0;
        if (condition) {
            const config = __ctHelpers.derive({
                type: "object",
                properties: {}
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "object",
                properties: {
                    bar: {
                        type: "number"
                    }
                },
                required: ["bar"]
            } as const satisfies __ctHelpers.JSONSchema, {}, () => ({ bar: 1 }));
            return config.key("bar");
        }
        return config.bar;
    });
    return outer;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: ["number", "string"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
