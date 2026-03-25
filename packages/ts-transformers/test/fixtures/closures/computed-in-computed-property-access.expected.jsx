import * as __cfHelpers from "commonfabric";
import { computed, pattern } from "commonfabric";
// FIXTURE: computed-in-computed-property-access
// Verifies: property access on a computed() result declared INSIDE another computed()
//   gets transformed to .key() access
//   foo.bar → foo.key("bar") where foo = computed(() => ({ bar: 1 }))
// Context: Local variables holding OpaqueRef values (from compute/derive calls)
//   inside a derive callback need .key() rewriting even though they are not
//   captured from an outer scope.
export default pattern(() => {
    const outer = __cfHelpers.derive({
        type: "object",
        properties: {}
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {}, () => {
        const foo = __cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {}, () => ({ bar: 1 }));
        return foo.key("bar");
    });
    return outer;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
