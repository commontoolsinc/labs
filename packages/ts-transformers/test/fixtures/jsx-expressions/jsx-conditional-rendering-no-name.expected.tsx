import * as __ctHelpers from "commontools";
import { ifElse, recipe, UI } from "commontools";
interface State {
    isActive: boolean;
    count: number;
    userType: string;
    score: number;
    hasPermission: boolean;
    isPremium: boolean;
}
export default recipe({
    type: "object",
    properties: {
        isActive: {
            type: "boolean"
        },
        count: {
            type: "number"
        },
        userType: {
            type: "string"
        },
        score: {
            type: "number"
        },
        hasPermission: {
            type: "boolean"
        },
        isPremium: {
            type: "boolean"
        }
    },
    required: ["isActive", "count", "userType", "score", "hasPermission", "isPremium"]
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
                    $ref: "#/$defs/VNode"
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
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["$UI"]
        },
        VNode: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    "enum": ["vnode"]
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
                    "enum": [false]
                }, {
                    type: "boolean",
                    "enum": [true]
                }, {
                    $ref: "#/$defs/VNode"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
                }, {
                    type: "object",
                    properties: {}
                }, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/RenderNode"
                    }
                }, {
                    type: "null"
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
                        "enum": [false]
                    }, {
                        type: "boolean",
                        "enum": [true]
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Basic Ternary</h3>
        <span>{__ctHelpers.ifElse({
            type: "boolean",
            asOpaque: true
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Active", "Inactive"]
        } as const satisfies __ctHelpers.JSONSchema, state.isActive, "Active", "Inactive")}</span>
        <span>{__ctHelpers.ifElse({
            type: "boolean",
            asOpaque: true
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Authorized", "Denied"]
        } as const satisfies __ctHelpers.JSONSchema, state.hasPermission, "Authorized", "Denied")}</span>

        <h3>Ternary with Comparisons</h3>
        <span>{__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["High", "Low"]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["count"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                count: state.count
            } }, ({ state }) => state.count > 10), "High", "Low")}</span>
        <span>{__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["B", "C"]
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["B", "C", "A"]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        score: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["score"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                score: state.score
            } }, ({ state }) => state.score >= 90), "A", __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        score: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["score"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["B", "C"]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                score: state.score
            } }, ({ state }) => state.score >= 80 ? "B" : "C"))}</span>
        <span>
          {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Single", "Multiple"]
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Single", "Multiple", "Empty"]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["count"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                count: state.count
            } }, ({ state }) => state.count === 0), "Empty", __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["count"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Single", "Multiple"]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                count: state.count
            } }, ({ state }) => state.count === 1
            ? "Single"
            : "Multiple"))}
        </span>

        <h3>Nested Ternary</h3>
        <span>
          {__ctHelpers.ifElse({
            type: "boolean",
            asOpaque: true
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Premium Active", "Regular Active"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Inactive", "Premium Active", "Regular Active"]
        } as const satisfies __ctHelpers.JSONSchema, state.isActive, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        isPremium: {
                            type: "boolean",
                            asOpaque: true
                        }
                    },
                    required: ["isPremium"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Premium Active", "Regular Active"]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                isPremium: state.isPremium
            } }, ({ state }) => (state.isPremium ? "Premium Active" : "Regular Active")), "Inactive")}
        </span>
        <span>
          {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["User", "Guest"]
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["User", "Guest", "Admin"]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        userType: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["userType"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                userType: state.userType
            } }, ({ state }) => state.userType === "admin"), "Admin", __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        userType: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["userType"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["User", "Guest"]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                userType: state.userType
            } }, ({ state }) => state.userType === "user"
            ? "User"
            : "Guest"))}
        </span>

        <h3>Complex Conditions</h3>
        <span>
          {__ctHelpers.ifElse({
            type: "boolean",
            asOpaque: true
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Full Access", "Limited Access"]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        isActive: {
                            type: "boolean",
                            asOpaque: true
                        },
                        hasPermission: {
                            type: "boolean",
                            asOpaque: true
                        }
                    },
                    required: ["isActive", "hasPermission"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean",
            asOpaque: true
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                isActive: state.isActive,
                hasPermission: state.hasPermission
            } }, ({ state }) => state.isActive && state.hasPermission), "Full Access", "Limited Access")}
        </span>
        <span>
          {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["In Range", "Out of Range"]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["count"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                count: state.count
            } }, ({ state }) => state.count > 0 && state.count < 10), "In Range", "Out of Range")}
        </span>
        <span>
          {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Premium Features", "Basic Features"]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        isPremium: {
                            type: "boolean",
                            asOpaque: true
                        },
                        score: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["isPremium", "score"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                isPremium: state.isPremium,
                score: state.score
            } }, ({ state }) => state.isPremium || state.score > 100), "Premium Features", "Basic Features")}
        </span>

        <h3>IfElse Component</h3>
        {ifElse({
                type: "boolean",
                asOpaque: true
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
                $ref: "#/$defs/AnonymousType_1",
                $defs: {
                    AnonymousType_1: {
                        $ref: "#/$defs/UIRenderable",
                        asOpaque: true
                    },
                    UIRenderable: {
                        type: "object",
                        properties: {
                            $UI: {
                                $ref: "#/$defs/VNode"
                            }
                        },
                        required: ["$UI"]
                    },
                    VNode: {
                        type: "object",
                        properties: {
                            type: {
                                type: "string"
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
                                type: "boolean"
                            }, {}, {
                                type: "object",
                                properties: {}
                            }, {
                                type: "array",
                                items: {
                                    $ref: "#/$defs/RenderNode"
                                }
                            }, {
                                type: "null"
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
                                    type: "boolean"
                                }, {
                                    type: "object",
                                    additionalProperties: true
                                }, {
                                    type: "array",
                                    items: true
                                }, {}, {
                                    type: "null"
                                }]
                        }
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, state.isActive, <div>User is active with {state.count} items</div>, <div>User is inactive</div>)}

        {ifElse({
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
        } as const satisfies __ctHelpers.JSONSchema, {
            $ref: "#/$defs/AnonymousType_1",
            $defs: {
                AnonymousType_1: {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
                },
                UIRenderable: {
                    type: "object",
                    properties: {
                        $UI: {
                            $ref: "#/$defs/VNode"
                        }
                    },
                    required: ["$UI"]
                },
                VNode: {
                    type: "object",
                    properties: {
                        type: {
                            type: "string"
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
                            type: "boolean"
                        }, {}, {
                            type: "object",
                            properties: {}
                        }, {
                            type: "array",
                            items: {
                                $ref: "#/$defs/RenderNode"
                            }
                        }, {
                            type: "null"
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
                                type: "boolean"
                            }, {
                                type: "object",
                                additionalProperties: true
                            }, {
                                type: "array",
                                items: true
                            }, {}, {
                                type: "null"
                            }]
                    }
                }
            }
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["count"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                count: state.count
            } }, ({ state }) => state.count > 5), <ul>
            <li>Many items: {state.count}</li>
          </ul>, <p>Few items: {state.count}</p>)}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
