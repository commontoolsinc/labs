import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe("MapSingleCapture", (_state) => {
    const people = cell([
        { id: "1", name: "Alice" },
        { id: "2", name: "Bob" },
    ]);
    return {
        [UI]: (<div>
        {__ctHelpers.derive({
            type: "object",
            properties: {
                people: {
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
                    },
                    asCell: true
                }
            },
            required: ["people"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "boolean",
                    enum: [false]
                }, {
                    $ref: "#/$defs/Element"
                }],
            $defs: {
                Element: {
                    type: "object",
                    properties: {
                        type: {
                            type: "string",
                            enum: ["vnode"]
                        },
                        name: {
                            type: "string"
                        },
                        props: {
                            $ref: "#/$defs/Props"
                        },
                        children: {
                            $ref: "#/$defs/RenderNode"
                        },
                        $UI: {
                            $ref: "#/$defs/VNode"
                        }
                    },
                    required: ["type", "name", "props"]
                },
                VNode: {
                    type: "object",
                    properties: {
                        type: {
                            type: "string",
                            enum: ["vnode"]
                        },
                        name: {
                            type: "string"
                        },
                        props: {
                            $ref: "#/$defs/Props"
                        },
                        children: {
                            $ref: "#/$defs/RenderNode"
                        },
                        $UI: {
                            $ref: "#/$defs/VNode"
                        }
                    },
                    required: ["type", "name", "props"]
                },
                RenderNode: {
                    anyOf: [{
                            type: "string"
                        }, {
                            type: "number"
                        }, {
                            type: "boolean",
                            enum: [false]
                        }, {
                            type: "boolean",
                            enum: [true]
                        }, {
                            $ref: "#/$defs/VNode"
                        }, {
                            type: "object",
                            properties: {}
                        }, {
                            type: "array",
                            items: {
                                $ref: "#/$defs/RenderNode"
                            }
                        }]
                },
                Props: {
                    type: "object",
                    properties: {},
                    additionalProperties: {
                        anyOf: [{
                                type: "string"
                            }, {
                                type: "number"
                            }, {
                                type: "boolean",
                                enum: [false]
                            }, {
                                type: "boolean",
                                enum: [true]
                            }, {
                                type: "object",
                                additionalProperties: true
                            }, {
                                type: "array",
                                items: true
                            }, {
                                asCell: true
                            }, {
                                asStream: true
                            }, {
                                type: "null"
                            }]
                    }
                }
            }
        } as const satisfies __ctHelpers.JSONSchema, { people: people }, ({ people }) => people.length > 0 && (<ul>
            {people.map((person) => (<li key={person.id}>{person.name}</li>))}
          </ul>))}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
