import * as __cfHelpers from "commonfabric";
import { cell, pattern, UI } from "commonfabric";
// FIXTURE: map-single-capture-no-name
// Verifies: same map + length guard transforms work with _state: any parameter
//   people.get().length > 0 && <ul>{people.map(...)}</ul> → when(..., <ul>{mapWithPattern(...)}</ul>)
// Context: Variant of map-single-capture with _state: any
export default pattern((_state: any) => {
    const people = cell([
        { id: "1", name: "Alice" },
        { id: "2", name: "Bob" },
    ], {
        type: "array",
        items: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
        }
    } as const satisfies __cfHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {__cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{
                    type: "boolean"
                }, {}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                people: {
                    type: "array",
                    items: {
                        type: "unknown"
                    },
                    asCell: true
                }
            },
            required: ["people"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { people: people }, ({ people }) => people.get().length > 0), <ul>
            {people.mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const person = __ct_pattern_input.key("element");
                const index = __ct_pattern_input.key("index");
                return (<li key={index}>{person.key("name")}</li>);
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string"
                            },
                            name: {
                                type: "string"
                            }
                        },
                        required: ["id", "name"]
                    },
                    index: {
                        type: "number"
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
          </ul>)}
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
