function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, derive, lift, pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const liftSummary = lift({
    type: "object",
    properties: {
        primary: {
            type: "number",
            asCell: ["cell"]
        },
        secondary: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["primary", "secondary"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        primary: {
            type: "number"
        },
        secondary: {
            type: "number"
        },
        difference: {
            type: "number"
        }
    },
    required: ["primary", "secondary", "difference"]
} as const satisfies __cfHelpers.JSONSchema, ({ primary, secondary }) => {
    const primaryValue = primary.get();
    const secondaryValue = secondary.get();
    return {
        primary: primaryValue,
        secondary: secondaryValue,
        difference: primaryValue - secondaryValue,
    };
});
// FIXTURE: context-lift-result-property-projection-shorthand
// Verifies: shorthand object returns preserve the projected derive() result type
//   return { difference } → result schema difference: number
export default pattern((__cf_pattern_input) => {
    const primary = __cf_pattern_input.key("primary");
    const secondary = __cf_pattern_input.key("secondary");
    const summary = liftSummary({ primary, secondary });
    const difference = derive({
        type: "object",
        properties: {
            difference: {
                type: "number"
            }
        },
        required: ["difference"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, summary, (snapshot) => snapshot.difference);
    return { difference };
}, {
    type: "object",
    properties: {
        primary: {
            type: "number",
            asCell: ["cell"]
        },
        secondary: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["primary", "secondary"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        difference: {
            type: "number"
        }
    },
    required: ["difference"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
