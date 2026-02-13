import * as __ctHelpers from "commontools";
/**
 * Regression test: computed() inside ifElse branch should not double-wrap .get()
 *
 * When a computed() callback is inside an ifElse branch, the OpaqueRefJSX
 * transformer's rewriteChildExpressions should NOT wrap expressions like
 * `toggle.get()` in an extra derive, since the computed callback is already
 * a safe reactive context.
 *
 * Bug: secondToggle.get() was returning CellImpl instead of boolean
 * Fix: Added isInsideSafeCallbackWrapper check in rewriteChildExpressions
 */
import { computed, ifElse, pattern, UI, Writable } from "commontools";
export default pattern({
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __ctHelpers.JSONSchema, {
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
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
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
} as const satisfies __ctHelpers.JSONSchema, () => {
    const showOuter = Writable.of(false, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    const secondToggle = Writable.of(false, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {/* Case A: Top-level computed - always worked */}
        <div style={__ctHelpers.derive({
                type: "object",
                properties: {
                    secondToggle: {
                        type: "boolean",
                        asCell: true
                    }
                },
                required: ["secondToggle"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "object",
                properties: {
                    background: {
                        type: "string"
                    }
                },
                required: ["background"]
            } as const satisfies __ctHelpers.JSONSchema, { secondToggle: secondToggle }, ({ secondToggle }) => {
                const val = secondToggle.get();
                return { background: val ? "green" : "red" };
            })}>Case A</div>

        {/* Case B: Computed inside ifElse - this was the bug */}
        {ifElse({
                type: "boolean",
                asCell: true
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{}, {
                        type: "object",
                        properties: {}
                    }]
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{}, {
                        type: "object",
                        properties: {}
                    }]
            } as const satisfies __ctHelpers.JSONSchema, {
                $ref: "#/$defs/UIRenderable",
                asOpaque: true,
                $defs: {
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
            } as const satisfies __ctHelpers.JSONSchema, showOuter, <div style={__ctHelpers.derive({
                    type: "object",
                    properties: {
                        secondToggle: {
                            type: "boolean",
                            asCell: true
                        }
                    },
                    required: ["secondToggle"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "object",
                    properties: {
                        background: {
                            type: "string"
                        }
                    },
                    required: ["background"]
                } as const satisfies __ctHelpers.JSONSchema, { secondToggle: secondToggle }, ({ secondToggle }) => {
                    // This .get() should NOT be wrapped in extra derive
                    const val = secondToggle.get();
                    return { background: val ? "green" : "red" };
                })}>Case B</div>, <div>Hidden</div>)}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
