function __cfBindVerifiedBinding(value: any, metadata: any) {
    if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {
        Object.defineProperty(value, "__cfVerifiedBindingIdentity", {
            value: metadata,
            configurable: true
        });
    }
    if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {
        var implementation = value.implementation;
        if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {
            Object.defineProperty(implementation, "__cfVerifiedBindingIdentity", {
                value: metadata,
                configurable: true
            });
        }
    }
    return value;
}
function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const COLUMN_INDICES = __cfHelpers.__cf_data([0, 1, 2]);
interface Input {
    weekDates: string[];
    todayDate: string;
}
const __cfLift_1 = __cfHelpers.lift<{
    weekDates: string[];
    todayDate: string;
    colIdx: number;
}, boolean>(({ weekDates, todayDate, colIdx }) => weekDates?.[colIdx] === todayDate, {
    type: "object",
    properties: {
        weekDates: {
            type: "array",
            items: {
                type: "string"
            }
        },
        todayDate: {
            type: "string"
        },
        colIdx: {
            type: "number"
        }
    },
    required: ["weekDates", "todayDate", "colIdx"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 26, col: 26 },
    bindingName: "isToday"
});
// FIXTURE: map-plain-array-callback-local-comparison
// Verifies: a callback-local binding inside a plain-array .map() lowers like the
// same binding in the pattern body
//   COLUMN_INDICES.map(fn)                  -> plain .map() remains plain
//   const isToday = weekDates?.[colIdx] === todayDate
//                                           -> lift-applied binding capturing
//                                              weekDates, todayDate and colIdx
//   isToday as a JSX ternary condition      -> ifElse over the lifted binding
// Context: The fixed-column calendar shape — a plain index array mapped inside
// JSX, with the per-column comparison named before it is used as a condition
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const weekDates = __cf_pattern_input.key("weekDates");
    const todayDate = __cf_pattern_input.key("todayDate");
    return {
        [UI]: (<div>
        {COLUMN_INDICES.map((colIdx) => {
                const isToday = __cfLift_1({
                    weekDates: weekDates,
                    todayDate: todayDate,
                    colIdx: colIdx
                }).for("isToday", true);
                return <div>{__cfHelpers.ifElse({
                    type: "boolean"
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, {
                    "enum": ["Today", "Other"]
                } as const satisfies __cfHelpers.JSONSchema, isToday, "Today", "Other")}</div>;
            })}
      </div>)
    };
}, {
    type: "object",
    properties: {
        weekDates: {
            type: "array",
            items: {
                type: "string"
            }
        },
        todayDate: {
            type: "string"
        }
    },
    required: ["weekDates", "todayDate"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 21, col: 30 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
