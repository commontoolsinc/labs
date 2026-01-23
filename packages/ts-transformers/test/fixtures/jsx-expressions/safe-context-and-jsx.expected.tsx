import * as __ctHelpers from "commontools";
// deno-lint-ignore-file no-unused-vars
import { handler, computed } from "commontools";
// Test: && with JSX inside handler callback should transform to when()
const MyHandler = handler({
    type: "object",
    properties: {
        bubbles: {
            type: "boolean"
        },
        cancelBubble: {
            type: "boolean"
        },
        cancelable: {
            type: "boolean"
        },
        composed: {
            type: "boolean"
        },
        currentTarget: {
            anyOf: [{
                    $ref: "#/$defs/EventTarget"
                }, {
                    type: "null"
                }]
        },
        defaultPrevented: {
            type: "boolean"
        },
        eventPhase: {
            type: "number"
        },
        isTrusted: {
            type: "boolean"
        },
        returnValue: {
            type: "boolean"
        },
        srcElement: {
            anyOf: [{
                    $ref: "#/$defs/EventTarget"
                }, {
                    type: "null"
                }]
        },
        target: {
            anyOf: [{
                    $ref: "#/$defs/EventTarget"
                }, {
                    type: "null"
                }]
        },
        timeStamp: {
            type: "number"
        },
        type: {
            type: "string"
        },
        NONE: {
            type: "number",
            "enum": [0]
        },
        CAPTURING_PHASE: {
            type: "number",
            "enum": [1]
        },
        AT_TARGET: {
            type: "number",
            "enum": [2]
        },
        BUBBLING_PHASE: {
            type: "number",
            "enum": [3]
        }
    },
    required: ["bubbles", "cancelBubble", "cancelable", "composed", "currentTarget", "defaultPrevented", "eventPhase", "isTrusted", "returnValue", "srcElement", "target", "timeStamp", "type", "NONE", "CAPTURING_PHASE", "AT_TARGET", "BUBBLING_PHASE"],
    $defs: {
        EventTarget: {
            type: "object",
            properties: {}
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        show: {
            type: "boolean"
        }
    },
    required: ["show"]
} as const satisfies __ctHelpers.JSONSchema, (_event, { show }) => {
    return <div>{__ctHelpers.when({
        type: "boolean"
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
    } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
        type: "object",
        properties: {
            show: {
                type: "boolean"
            }
        },
        required: ["show"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, { show: show }, ({ show }) => show), <span>Content</span>)}</div>;
});
// Test: || with JSX inside handler callback should transform to unless()
const MyHandler2 = handler({
    type: "object",
    properties: {
        bubbles: {
            type: "boolean"
        },
        cancelBubble: {
            type: "boolean"
        },
        cancelable: {
            type: "boolean"
        },
        composed: {
            type: "boolean"
        },
        currentTarget: {
            anyOf: [{
                    $ref: "#/$defs/EventTarget"
                }, {
                    type: "null"
                }]
        },
        defaultPrevented: {
            type: "boolean"
        },
        eventPhase: {
            type: "number"
        },
        isTrusted: {
            type: "boolean"
        },
        returnValue: {
            type: "boolean"
        },
        srcElement: {
            anyOf: [{
                    $ref: "#/$defs/EventTarget"
                }, {
                    type: "null"
                }]
        },
        target: {
            anyOf: [{
                    $ref: "#/$defs/EventTarget"
                }, {
                    type: "null"
                }]
        },
        timeStamp: {
            type: "number"
        },
        type: {
            type: "string"
        },
        NONE: {
            type: "number",
            "enum": [0]
        },
        CAPTURING_PHASE: {
            type: "number",
            "enum": [1]
        },
        AT_TARGET: {
            type: "number",
            "enum": [2]
        },
        BUBBLING_PHASE: {
            type: "number",
            "enum": [3]
        }
    },
    required: ["bubbles", "cancelBubble", "cancelable", "composed", "currentTarget", "defaultPrevented", "eventPhase", "isTrusted", "returnValue", "srcElement", "target", "timeStamp", "type", "NONE", "CAPTURING_PHASE", "AT_TARGET", "BUBBLING_PHASE"],
    $defs: {
        EventTarget: {
            type: "object",
            properties: {}
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "null"
                }]
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, (_event, { value }) => {
    return <div>{__ctHelpers.unless({
        anyOf: [{
                type: "string"
            }, {
                type: "null"
            }]
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
    } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
        type: "object",
        properties: {
            value: {
                anyOf: [{
                        type: "string"
                    }, {
                        type: "null"
                    }]
            }
        },
        required: ["value"]
    } as const satisfies __ctHelpers.JSONSchema, {
        anyOf: [{
                type: "string"
            }, {
                type: "null"
            }]
    } as const satisfies __ctHelpers.JSONSchema, { value: value }, ({ value }) => value), <span>Fallback</span>)}</div>;
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
