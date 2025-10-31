import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface Item {
    id: number;
    name: string;
}
interface User {
    firstName: string;
    lastName: string;
}
interface State {
    items: Item[];
    currentUser: User;
}
export default recipe({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        currentUser: {
            $ref: "#/$defs/User"
        }
    },
    required: ["items", "currentUser"],
    $defs: {
        User: {
            type: "object",
            properties: {
                firstName: {
                    type: "string"
                },
                lastName: {
                    type: "string"
                }
            },
            required: ["firstName", "lastName"]
        },
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {state.items.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    currentUser: {
                                        type: "object",
                                        properties: {
                                            firstName: {
                                                type: "string",
                                                asOpaque: true
                                            },
                                            lastName: {
                                                type: "string",
                                                asOpaque: true
                                            }
                                        },
                                        required: ["firstName", "lastName"]
                                    }
                                },
                                required: ["currentUser"]
                            }
                        },
                        required: ["state"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            id: {
                                type: "number"
                            },
                            name: {
                                type: "string"
                            }
                        },
                        required: ["id", "name"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { state } }) => (<div>
            {item.name} - edited by {state.currentUser.firstName} {state.currentUser.lastName}
          </div>)), {
                state: {
                    currentUser: {
                        firstName: state.currentUser.firstName,
                        lastName: state.currentUser.lastName
                    }
                }
            })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
