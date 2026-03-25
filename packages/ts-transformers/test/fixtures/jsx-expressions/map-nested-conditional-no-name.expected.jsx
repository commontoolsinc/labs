import * as __cfHelpers from "commonfabric";
import { cell, pattern, UI } from "commonfabric";
// FIXTURE: map-nested-conditional-no-name
// Verifies: same nested conditional map transforms work when pattern param is typed as any
//   showList && <div>{items.map(...)}</div> → when(showList, <div>{items.mapWithPattern(...)}</div>)
// Context: Variant of map-nested-conditional with _state: any instead of named pattern
export default pattern((_state: any) => {
    const items = cell([{ name: "apple" }, { name: "banana" }], {
        type: "array",
        items: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    } as const satisfies __cfHelpers.JSONSchema);
    const showList = cell(true, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema);
    return {
        [UI]: (<div>
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
        } as const satisfies __cfHelpers.JSONSchema, showList, <div>
            {items.mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                return (<div>
                {__cfHelpers.when({
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, {
                    anyOf: [{}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __cfHelpers.JSONSchema, {
                    anyOf: [{
                            type: "string"
                        }, {}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __cfHelpers.JSONSchema, item.key("name"), <span>{item.key("name")}</span>)}
              </div>);
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            }
                        },
                        required: ["name"]
                    }
                },
                required: ["element"]
            } as const satisfies __cfHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        $ref: "#/$defs/UIRenderable"
                    }, {
                        type: "object",
                        properties: {}
                    }],
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
            } as const satisfies __cfHelpers.JSONSchema), {})}
          </div>)}
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
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
