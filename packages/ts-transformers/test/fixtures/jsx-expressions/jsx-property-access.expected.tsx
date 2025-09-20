/// <cts-enable />
import { h, recipe, UI, ifElse, derive, JSONSchema } from "commontools";
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
    $schema: "https://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
        user: {
            $ref: "#/definitions/User"
        },
        config: {
            $ref: "#/definitions/Config"
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
    definitions: {
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
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Basic Property Access</h3>
        <h1>{state.user.name}</h1>
        <p>Age: {state.user.age}</p>
        <p>Active: {ifElse(state.user.active, "Yes", "No")}</p>
        
        <h3>Nested Property Access</h3>
        <p>Bio: {state.user.profile.bio}</p>
        <p>Location: {state.user.profile.location}</p>
        <p>Theme: {state.user.profile.settings.theme}</p>
        <p>Notifications: {ifElse(state.user.profile.settings.notifications, "On", "Off")}</p>
        
        <h3>Property Access with Operations</h3>
        <p>Age + 1: {derive(state.user.age, _v1 => _v1 + 1)}</p>
        <p>Name length: {derive(state.user.name, _v1 => _v1.length)}</p>
        <p>Uppercase name: {derive(state.user.name, _v1 => _v1.toUpperCase())}</p>
        <p>Location includes city: {ifElse(derive(state.user.profile.location, _v1 => _v1.includes("City")), "Yes", "No")}</p>
        
        <h3>Array Element Access</h3>
        <p>Item at index: {derive({ state_items: state.items, state_index: state.index }, ({ state_items: _v1, state_index: _v2 }) => _v1[_v2])}</p>
        <p>First item: {state.items[0]}</p>
        <p>Last item: {derive(state.items, _v1 => _v1[_v1.length - 1])}</p>
        <p>Number at index: {derive({ state_numbers: state.numbers, state_index: state.index }, ({ state_numbers: _v1, state_index: _v2 }) => _v1[_v2])}</p>
        
        <h3>Config Access with Styles</h3>
        <p style={{
            color: state.config.theme.primaryColor,
            fontSize: derive(state.config.theme.fontSize, _v1 => _v1 + "px")
        }}>
          Styled text
        </p>
        <div style={{
            backgroundColor: ifElse(state.config.features.darkMode, "#333", "#fff"),
            borderColor: state.config.theme.secondaryColor
        }}>
          Theme-aware box
        </div>
        
        <h3>Complex Property Chains</h3>
        <p>{derive({ state_user_name: state.user.name, state_user_profile_location: state.user.profile.location }, ({ state_user_name: _v1, state_user_profile_location: _v2 }) => _v1 + " from " + _v2)}</p>
        <p>Font size + 2: {derive(state.config.theme.fontSize, _v1 => _v1 + 2)}px</p>
        <p>Has beta and dark mode: {ifElse(derive({ state_config_features_beta: state.config.features.beta, state_config_features_darkMode: state.config.features.darkMode }, ({ state_config_features_beta: _v1, state_config_features_darkMode: _v2 }) => _v1 && _v2), "Yes", "No")}</p>
      </div>),
    };
});
