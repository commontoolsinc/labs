import * as __ctHelpers from "commontools";
import { cell, pattern, UI } from "commontools";
// FIXTURE: logical-and-simple-ref
// Verifies: simple opaque ref && <JSX> is transformed to when() for short-circuit rendering
//   showPanel && <div>Panel content</div> → when(showPanel, <div>Panel content</div>)
//   userName && <span>Hello</span>        → when(userName, <span>Hello</span>)
export default pattern((_state) => {
    const showPanel = cell(true, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    const userName = cell("Alice", {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {/* Simple opaque ref with JSX on right - SHOULD use when for short-circuit optimization */}
        {__ctHelpers.when({
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
        } as const satisfies __ctHelpers.JSONSchema, showPanel, <div>Panel content</div>)}

        {/* Another simple ref */}
        {__ctHelpers.when({
            type: "string",
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
        } as const satisfies __ctHelpers.JSONSchema, userName, <span>Hello {userName}</span>)}
      </div>),
    };
}, false as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
