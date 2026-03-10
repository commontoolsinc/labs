import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface User {
    name: string;
    age: number;
    active: boolean;
    profile: {
        bio: string;
        location: string;
        settings: {
            theme: string;
            notifications: boolean;
        };
    };
}
interface Config {
    theme: {
        primaryColor: string;
        secondaryColor: string;
        fontSize: number;
    };
    features: {
        darkMode: boolean;
        beta: boolean;
    };
}
interface State {
    user: User;
    config: Config;
    items: string[];
    index: number;
    numbers: number[];
}
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Basic Property Access</h3>
        <h1>{__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        user: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"]
                        }
                    },
                    required: ["user"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                user: {
                    name: state.key("user").name
                }
            } }, ({ state }) => state.user.name)}</h1>
        <p>Age: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        user: {
                            type: "object",
                            properties: {
                                age: {
                                    type: "number"
                                }
                            },
                            required: ["age"]
                        }
                    },
                    required: ["user"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                user: {
                    age: state.key("user").age
                }
            } }, ({ state }) => state.user.age)}</p>
        <p>Active: {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        user: {
                            type: "object",
                            properties: {
                                active: {
                                    type: "boolean"
                                }
                            },
                            required: ["active"]
                        }
                    },
                    required: ["user"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                user: {
                    active: state.key("user").active
                }
            } }, ({ state }) => state.user.active), "Yes", "No")}</p>

        <h3>Nested Property Access</h3>
        <p>Bio: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        user: {
                            type: "object",
                            properties: {
                                profile: {
                                    type: "object",
                                    properties: {
                                        bio: {
                                            type: "string"
                                        }
                                    },
                                    required: ["bio"]
                                }
                            },
                            required: ["profile"]
                        }
                    },
                    required: ["user"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                user: {
                    profile: {
                        bio: state.key("user").profile.bio
                    }
                }
            } }, ({ state }) => state.user.profile.bio)}</p>
        <p>Location: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        user: {
                            type: "object",
                            properties: {
                                profile: {
                                    type: "object",
                                    properties: {
                                        location: {
                                            type: "string"
                                        }
                                    },
                                    required: ["location"]
                                }
                            },
                            required: ["profile"]
                        }
                    },
                    required: ["user"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                user: {
                    profile: {
                        location: state.key("user").profile.location
                    }
                }
            } }, ({ state }) => state.user.profile.location)}</p>
        <p>Theme: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        user: {
                            type: "object",
                            properties: {
                                profile: {
                                    type: "object",
                                    properties: {
                                        settings: {
                                            type: "object",
                                            properties: {
                                                theme: {
                                                    type: "string"
                                                }
                                            },
                                            required: ["theme"]
                                        }
                                    },
                                    required: ["settings"]
                                }
                            },
                            required: ["profile"]
                        }
                    },
                    required: ["user"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                user: {
                    profile: {
                        settings: {
                            theme: state.key("user").profile.settings.theme
                        }
                    }
                }
            } }, ({ state }) => state.user.profile.settings.theme)}</p>
        <p>
          Notifications:{" "}
          {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["On", "Off"]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        user: {
                            type: "object",
                            properties: {
                                profile: {
                                    type: "object",
                                    properties: {
                                        settings: {
                                            type: "object",
                                            properties: {
                                                notifications: {
                                                    type: "boolean"
                                                }
                                            },
                                            required: ["notifications"]
                                        }
                                    },
                                    required: ["settings"]
                                }
                            },
                            required: ["profile"]
                        }
                    },
                    required: ["user"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                user: {
                    profile: {
                        settings: {
                            notifications: state.key("user").profile.settings.notifications
                        }
                    }
                }
            } }, ({ state }) => state.user.profile.settings.notifications), "On", "Off")}
        </p>

        <h3>Property Access with Operations</h3>
        <p>Age + 1: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        user: {
                            type: "object",
                            properties: {
                                age: {
                                    type: "number"
                                }
                            },
                            required: ["age"]
                        }
                    },
                    required: ["user"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                user: {
                    age: state.key("user").age
                }
            } }, ({ state }) => state.user.age + 1)}</p>
        <p>Name length: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        user: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "object",
                                    properties: {
                                        length: {
                                            type: "number"
                                        }
                                    },
                                    required: ["length"]
                                }
                            },
                            required: ["name"]
                        }
                    },
                    required: ["user"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                user: {
                    name: {
                        length: state.key("user").name.length
                    }
                }
            } }, ({ state }) => state.user.name.length)}</p>
        <p>Uppercase name: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        user: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"]
                        }
                    },
                    required: ["user"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                user: {
                    name: state.key("user").name
                }
            } }, ({ state }) => state.user.name.toUpperCase())}</p>
        <p>
          Location includes city:{" "}
          {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        user: {
                            type: "object",
                            properties: {
                                profile: {
                                    type: "object",
                                    properties: {
                                        location: {
                                            type: "string"
                                        }
                                    },
                                    required: ["location"]
                                }
                            },
                            required: ["profile"]
                        }
                    },
                    required: ["user"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                user: {
                    profile: {
                        location: state.key("user").profile.location
                    }
                }
            } }, ({ state }) => state.user.profile.location.includes("City")), "Yes", "No")}
        </p>

        <h3>Array Element Access</h3>
        <p>Item at index: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        },
                        index: {
                            type: "number"
                        }
                    },
                    required: ["items", "index"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: ["string", "undefined"]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.key("items"),
                index: state.key("index")
            } }, ({ state }) => state.items[state.index])}</p>
        <p>First item: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        }
                    },
                    required: ["items"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: ["string", "undefined"]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.key("items")
            } }, ({ state }) => state.items[0])}</p>
        <p>Last item: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        }
                    },
                    required: ["items"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: ["string", "undefined"]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.key("items")
            } }, ({ state }) => state.items[state.items.length - 1])}</p>
        <p>Number at index: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        numbers: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        },
                        index: {
                            type: "number"
                        }
                    },
                    required: ["numbers", "index"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: ["number", "undefined"]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                numbers: state.key("numbers"),
                index: state.key("index")
            } }, ({ state }) => state.numbers[state.index])}</p>

        <h3>Config Access with Styles</h3>
        <p style={{
            color: __ctHelpers.derive({
                type: "object",
                properties: {
                    state: {
                        type: "object",
                        properties: {
                            config: {
                                type: "object",
                                properties: {
                                    theme: {
                                        type: "object",
                                        properties: {
                                            primaryColor: {
                                                type: "string"
                                            }
                                        },
                                        required: ["primaryColor"]
                                    }
                                },
                                required: ["theme"]
                            }
                        },
                        required: ["config"]
                    }
                },
                required: ["state"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, { state: {
                    config: {
                        theme: {
                            primaryColor: state.key("config").theme.primaryColor
                        }
                    }
                } }, ({ state }) => state.config.theme.primaryColor),
            fontSize: __ctHelpers.derive({
                type: "object",
                properties: {
                    state: {
                        type: "object",
                        properties: {
                            config: {
                                type: "object",
                                properties: {
                                    theme: {
                                        type: "object",
                                        properties: {
                                            fontSize: {
                                                type: "number"
                                            }
                                        },
                                        required: ["fontSize"]
                                    }
                                },
                                required: ["theme"]
                            }
                        },
                        required: ["config"]
                    }
                },
                required: ["state"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, { state: {
                    config: {
                        theme: {
                            fontSize: state.key("config").theme.fontSize
                        }
                    }
                } }, ({ state }) => state.config.theme.fontSize + "px"),
        }}>
          Styled text
        </p>
        <div style={{
            backgroundColor: __ctHelpers.ifElse({
                type: "boolean"
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, {
                "enum": ["#333", "#fff"]
            } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
                type: "object",
                properties: {
                    state: {
                        type: "object",
                        properties: {
                            config: {
                                type: "object",
                                properties: {
                                    features: {
                                        type: "object",
                                        properties: {
                                            darkMode: {
                                                type: "boolean"
                                            }
                                        },
                                        required: ["darkMode"]
                                    }
                                },
                                required: ["features"]
                            }
                        },
                        required: ["config"]
                    }
                },
                required: ["state"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "boolean"
            } as const satisfies __ctHelpers.JSONSchema, { state: {
                    config: {
                        features: {
                            darkMode: state.key("config").features.darkMode
                        }
                    }
                } }, ({ state }) => state.config.features.darkMode), "#333", "#fff"),
            borderColor: __ctHelpers.derive({
                type: "object",
                properties: {
                    state: {
                        type: "object",
                        properties: {
                            config: {
                                type: "object",
                                properties: {
                                    theme: {
                                        type: "object",
                                        properties: {
                                            secondaryColor: {
                                                type: "string"
                                            }
                                        },
                                        required: ["secondaryColor"]
                                    }
                                },
                                required: ["theme"]
                            }
                        },
                        required: ["config"]
                    }
                },
                required: ["state"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, { state: {
                    config: {
                        theme: {
                            secondaryColor: state.key("config").theme.secondaryColor
                        }
                    }
                } }, ({ state }) => state.config.theme.secondaryColor),
        }}>
          Theme-aware box
        </div>

        <h3>Complex Property Chains</h3>
        <p>{__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        user: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                },
                                profile: {
                                    type: "object",
                                    properties: {
                                        location: {
                                            type: "string"
                                        }
                                    },
                                    required: ["location"]
                                }
                            },
                            required: ["name", "profile"]
                        }
                    },
                    required: ["user"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                user: {
                    name: state.key("user").name,
                    profile: {
                        location: state.key("user").profile.location
                    }
                }
            } }, ({ state }) => state.user.name + " from " + state.user.profile.location)}</p>
        <p>Font size + 2: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        config: {
                            type: "object",
                            properties: {
                                theme: {
                                    type: "object",
                                    properties: {
                                        fontSize: {
                                            type: "number"
                                        }
                                    },
                                    required: ["fontSize"]
                                }
                            },
                            required: ["theme"]
                        }
                    },
                    required: ["config"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                config: {
                    theme: {
                        fontSize: state.key("config").theme.fontSize
                    }
                }
            } }, ({ state }) => state.config.theme.fontSize + 2)}px</p>
        <p>
          Has beta and dark mode:{" "}
          {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        config: {
                            type: "object",
                            properties: {
                                features: {
                                    type: "object",
                                    properties: {
                                        beta: {
                                            type: "boolean"
                                        },
                                        darkMode: {
                                            type: "boolean"
                                        }
                                    },
                                    required: ["beta", "darkMode"]
                                }
                            },
                            required: ["features"]
                        }
                    },
                    required: ["config"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                config: {
                    features: {
                        beta: state.key("config").features.beta,
                        darkMode: state.key("config").features.darkMode
                    }
                }
            } }, ({ state }) => state.config.features.beta && state.config.features.darkMode), "Yes", "No")}
        </p>
      </div>),
    };
}, {
    type: "object",
    properties: {
        user: {
            $ref: "#/$defs/User"
        },
        config: {
            $ref: "#/$defs/Config"
        },
        items: {
            type: "array",
            items: {
                type: "string"
            }
        },
        index: {
            type: "number"
        },
        numbers: {
            type: "array",
            items: {
                type: "number"
            }
        }
    },
    required: ["user", "config", "items", "index", "numbers"],
    $defs: {
        Config: {
            type: "object",
            properties: {
                theme: {
                    type: "object",
                    properties: {
                        primaryColor: {
                            type: "string"
                        },
                        secondaryColor: {
                            type: "string"
                        },
                        fontSize: {
                            type: "number"
                        }
                    },
                    required: ["primaryColor", "secondaryColor", "fontSize"]
                },
                features: {
                    type: "object",
                    properties: {
                        darkMode: {
                            type: "boolean"
                        },
                        beta: {
                            type: "boolean"
                        }
                    },
                    required: ["darkMode", "beta"]
                }
            },
            required: ["theme", "features"]
        },
        User: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                age: {
                    type: "number"
                },
                active: {
                    type: "boolean"
                },
                profile: {
                    type: "object",
                    properties: {
                        bio: {
                            type: "string"
                        },
                        location: {
                            type: "string"
                        },
                        settings: {
                            type: "object",
                            properties: {
                                theme: {
                                    type: "string"
                                },
                                notifications: {
                                    type: "boolean"
                                }
                            },
                            required: ["theme", "notifications"]
                        }
                    },
                    required: ["bio", "location", "settings"]
                }
            },
            required: ["name", "age", "active", "profile"]
        }
    }
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
