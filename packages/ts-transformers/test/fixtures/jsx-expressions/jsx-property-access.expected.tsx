import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
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
export default recipe({
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Basic Property Access</h3>
        <h1>{state.user.name}</h1>
        <p>Age: {state.user.age}</p>
        <p>Active: {__ctHelpers.ifElse(state.user.active, "Yes", "No")}</p>

        <h3>Nested Property Access</h3>
        <p>Bio: {state.user.profile.bio}</p>
        <p>Location: {state.user.profile.location}</p>
        <p>Theme: {state.user.profile.settings.theme}</p>
        <p>
          Notifications:{" "}
          {__ctHelpers.ifElse(state.user.profile.settings.notifications, "On", "Off")}
        </p>

        <h3>Property Access with Operations</h3>
        <p>Age + 1: {__ctHelpers.derive({ state: {
                user: {
                    age: state.user.age
                }
            } }, ({ state }) => state.user.age + 1)}</p>
        <p>Name length: {state.user.name.length}</p>
        <p>Uppercase name: {__ctHelpers.derive({ state: {
                user: {
                    name: state.user.name
                }
            } }, ({ state }) => state.user.name.toUpperCase())}</p>
        <p>
          Location includes city:{" "}
          {__ctHelpers.ifElse(__ctHelpers.derive({ state: {
                user: {
                    profile: {
                        location: state.user.profile.location
                    }
                }
            } }, ({ state }) => state.user.profile.location.includes("City")), "Yes", "No")}
        </p>

        <h3>Array Element Access</h3>
        <p>Item at index: {__ctHelpers.derive({ state: {
                items: state.items,
                index: state.index
            } }, ({ state }) => state.items[state.index])}</p>
        <p>First item: {state.items[0]}</p>
        <p>Last item: {__ctHelpers.derive({ state: {
                items: state.items
            } }, ({ state }) => state.items[state.items.length - 1])}</p>
        <p>Number at index: {__ctHelpers.derive({ state: {
                numbers: state.numbers,
                index: state.index
            } }, ({ state }) => state.numbers[state.index])}</p>

        <h3>Config Access with Styles</h3>
        <p style={{
            color: state.config.theme.primaryColor,
            fontSize: __ctHelpers.derive({ state: {
                    config: {
                        theme: {
                            fontSize: state.config.theme.fontSize
                        }
                    }
                } }, ({ state }) => state.config.theme.fontSize + "px"),
        }}>
          Styled text
        </p>
        <div style={{
            backgroundColor: __ctHelpers.ifElse(state.config.features.darkMode, "#333", "#fff"),
            borderColor: state.config.theme.secondaryColor,
        }}>
          Theme-aware box
        </div>

        <h3>Complex Property Chains</h3>
        <p>{__ctHelpers.derive({ state: {
                user: {
                    name: state.user.name,
                    profile: {
                        location: state.user.profile.location
                    }
                }
            } }, ({ state }) => state.user.name + " from " + state.user.profile.location)}</p>
        <p>Font size + 2: {__ctHelpers.derive({ state: {
                config: {
                    theme: {
                        fontSize: state.config.theme.fontSize
                    }
                }
            } }, ({ state }) => state.config.theme.fontSize + 2)}px</p>
        <p>
          Has beta and dark mode:{" "}
          {__ctHelpers.ifElse(__ctHelpers.derive({ state: {
                config: {
                    features: {
                        beta: state.config.features.beta,
                        darkMode: state.config.features.darkMode
                    }
                }
            } }, ({ state }) => state.config.features.beta && state.config.features.darkMode), "Yes", "No")}
        </p>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
