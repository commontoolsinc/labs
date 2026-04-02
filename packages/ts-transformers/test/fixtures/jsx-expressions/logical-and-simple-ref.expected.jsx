function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
// FIXTURE: logical-and-simple-ref
// Verifies: simple opaque ref && <JSX> is transformed to when() for short-circuit rendering
//   showPanel && <div>Panel content</div> → when(showPanel, <div>Panel content</div>)
//   userName && <span>Hello</span>        → when(userName, <span>Hello</span>)
export default pattern((_state) => {
    const showPanel = cell(true, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema);
    const userName = cell("Alice", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {/* Simple opaque ref with JSX on right - SHOULD use when for short-circuit optimization */}
        {__cfHelpers.when({
            type: "boolean",
            asCell: true
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, showPanel, <div>Panel content</div>)}

        {/* Another simple ref */}
        {__cfHelpers.when({
            type: "string",
            asCell: true
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, userName, <span>Hello {userName}</span>)}
      </div>),
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
