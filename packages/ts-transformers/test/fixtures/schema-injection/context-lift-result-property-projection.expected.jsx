import * as __cfHelpers from "commonfabric";
import { Cell, derive, lift, pattern, Writable } from "commonfabric";
const liftSummary = lift({
    type: "object",
    properties: {
        primary: {
            type: "number",
            asCell: true
        },
        secondary: {
            type: "number",
            asCell: true
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
// FIXTURE: context-lift-result-property-projection
// Verifies: derive() preserves projected property schemas when the input comes
// from a typed lift() result rather than falling back to unknown
//   derive(summary, (snapshot) => snapshot.difference) → derive({ difference: number }, number, ...)
export default pattern((__ct_pattern_input) => {
    const primary = __ct_pattern_input.key("primary");
    const secondary = __ct_pattern_input.key("secondary");
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
    return {
        summary,
        difference,
    };
}, {
    type: "object",
    properties: {
        primary: {
            type: "number",
            asCell: true
        },
        secondary: {
            type: "number",
            asCell: true
        }
    },
    required: ["primary", "secondary"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        summary: {
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
        },
        difference: {
            type: "number"
        }
    },
    required: ["summary", "difference"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
