/// <cts-enable />
import { h, recipe, UI, derive, ifElse, JSONSchema } from "commontools";
interface State {
    user: {
        name: string;
        age: number;
        email: string;
        profile: {
            bio: string;
            location: string;
            website: string;
        };
        settings: {
            theme: string;
            notifications: boolean;
            privacy: string;
        };
    };
    config: {
        theme: {
            colors: {
                primary: string;
                secondary: string;
                background: string;
            };
            fonts: {
                heading: string;
                body: string;
                mono: string;
            };
            spacing: {
                small: number;
                medium: number;
                large: number;
            };
        };
        features: {
            darkMode: boolean;
            animations: boolean;
            betaFeatures: boolean;
        };
    };
    data: {
        items: Array<{
            id: number;
            name: string;
            value: number;
        }>;
        totals: {
            count: number;
            sum: number;
            average: number;
        };
    };
    deeply: {
        nested: {
            structure: {
                with: {
                    many: {
                        levels: {
                            value: string;
                            count: number;
                        };
                    };
                };
            };
        };
    };
    arrays: {
        first: string[];
        second: number[];
        nested: Array<{
            items: string[];
            count: number;
        }>;
    };
}
export default recipe({
    type: "object",
    properties: {
        user: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                age: {
                    type: "number"
                },
                email: {
                    type: "string"
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
                        website: {
                            type: "string"
                        }
                    },
                    required: ["bio", "location", "website"]
                },
                settings: {
                    type: "object",
                    properties: {
                        theme: {
                            type: "string"
                        },
                        notifications: {
                            type: "boolean"
                        },
                        privacy: {
                            type: "string"
                        }
                    },
                    required: ["theme", "notifications", "privacy"]
                }
            },
            required: ["name", "age", "email", "profile", "settings"]
        },
        config: {
            type: "object",
            properties: {
                theme: {
                    type: "object",
                    properties: {
                        colors: {
                            type: "object",
                            properties: {
                                primary: {
                                    type: "string"
                                },
                                secondary: {
                                    type: "string"
                                },
                                background: {
                                    type: "string"
                                }
                            },
                            required: ["primary", "secondary", "background"]
                        },
                        fonts: {
                            type: "object",
                            properties: {
                                heading: {
                                    type: "string"
                                },
                                body: {
                                    type: "string"
                                },
                                mono: {
                                    type: "string"
                                }
                            },
                            required: ["heading", "body", "mono"]
                        },
                        spacing: {
                            type: "object",
                            properties: {
                                small: {
                                    type: "number"
                                },
                                medium: {
                                    type: "number"
                                },
                                large: {
                                    type: "number"
                                }
                            },
                            required: ["small", "medium", "large"]
                        }
                    },
                    required: ["colors", "fonts", "spacing"]
                },
                features: {
                    type: "object",
                    properties: {
                        darkMode: {
                            type: "boolean"
                        },
                        animations: {
                            type: "boolean"
                        },
                        betaFeatures: {
                            type: "boolean"
                        }
                    },
                    required: ["darkMode", "animations", "betaFeatures"]
                }
            },
            required: ["theme", "features"]
        },
        data: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: {
                                type: "number"
                            },
                            name: {
                                type: "string"
                            },
                            value: {
                                type: "number"
                            }
                        },
                        required: ["id", "name", "value"]
                    }
                },
                totals: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number"
                        },
                        sum: {
                            type: "number"
                        },
                        average: {
                            type: "number"
                        }
                    },
                    required: ["count", "sum", "average"]
                }
            },
            required: ["items", "totals"]
        },
        deeply: {
            type: "object",
            properties: {
                nested: {
                    type: "object",
                    properties: {
                        structure: {
                            type: "object",
                            properties: {
                                with: {
                                    type: "object",
                                    properties: {
                                        many: {
                                            type: "object",
                                            properties: {
                                                levels: {
                                                    type: "object",
                                                    properties: {
                                                        value: {
                                                            type: "string"
                                                        },
                                                        count: {
                                                            type: "number"
                                                        }
                                                    },
                                                    required: ["value", "count"]
                                                }
                                            },
                                            required: ["levels"]
                                        }
                                    },
                                    required: ["many"]
                                }
                            },
                            required: ["with"]
                        }
                    },
                    required: ["structure"]
                }
            },
            required: ["nested"]
        },
        arrays: {
            type: "object",
            properties: {
                first: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                second: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                nested: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            items: {
                                type: "array",
                                items: {
                                    type: "string"
                                }
                            },
                            count: {
                                type: "number"
                            }
                        },
                        required: ["items", "count"]
                    }
                }
            },
            required: ["first", "second", "nested"]
        }
    },
    required: ["user", "config", "data", "deeply", "arrays"]
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Same Base, Different Properties</h3>
        {/* Multiple accesses to same object in one expression */}
        <p>User info: {state.user.name} (age: {state.user.age}, email: {state.user.email})</p>

        {/* String concatenation with multiple property accesses */}
        <p>Full profile: {commontools_1.derive({ state_user_name: state.user.name, state_user_profile_location: state.user.profile.location, state_user_profile_bio: state.user.profile.bio }, ({ state_user_name: _v1, state_user_profile_location: _v2, state_user_profile_bio: _v3 }) => _v1 + " from " + _v2 + " - " + _v3)}</p>

        {/* Arithmetic with multiple properties from same base */}
        <p>Age calculation: {commontools_1.derive(state.user.age, _v1 => _v1 * 12)} months, or {commontools_1.derive(state.user.age, _v1 => _v1 * 365)} days</p>

        <h3>Deeply Nested Property Chains</h3>
        {/* Multiple references to deeply nested object */}
        <p>Theme: {state.config.theme.colors.primary} / {state.config.theme.colors.secondary} on {state.config.theme.colors.background}</p>

        {/* Fonts from same nested structure */}
        <p>Typography: Headings in {state.config.theme.fonts.heading}, body in {state.config.theme.fonts.body}, code in {state.config.theme.fonts.mono}</p>

        {/* Mixed depth accesses */}
        <p>Config summary: Dark mode {commontools_1.ifElse(state.config.features.darkMode, "enabled", "disabled")} with {state.config.theme.colors.primary} primary color</p>

        <h3>Very Deep Nesting with Multiple References</h3>
        {/* Accessing different properties at same deep level */}
        <p>Deep value: {state.deeply.nested.structure.with.many.levels.value} (count: {state.deeply.nested.structure.with.many.levels.count})</p>

        {/* Mixed depth from same root */}
        <p>Mixed depths: {state.deeply.nested.structure.with.many.levels.value} in {state.deeply.nested.structure.with.many.levels.count} items</p>

        <h3>Arrays with Shared Base</h3>
        {/* Multiple array properties */}
        <p>Array info: First has {state.arrays.first.length} items, second has {state.arrays.second.length} items</p>

        {/* Nested array access with shared base */}
        <p>Nested: {state.arrays.nested[0].items.length} items in first, count is {state.arrays.nested[0].count}</p>
        
        {/* Array and property access mixed */}
        <p>First item: {state.arrays.first[0]} (total: {state.arrays.first.length})</p>

        <h3>Complex Expressions with Shared Bases</h3>
        {/* Conditional with multiple property accesses */}
        <p>Status: {commontools_1.ifElse(state.user.settings.notifications, commontools_1.derive({ state_user_name: state.user.name, state_user_settings_theme: state.user.settings.theme }, ({ state_user_name: _v1, state_user_settings_theme: _v2 }) => _v1 + " has notifications on with " + _v2 + " theme"), commontools_1.derive(state.user.name, _v1 => _v1 + " has notifications off"))}</p>

        {/* Computed expression with shared base */}
        <p>Spacing calc: {commontools_1.derive({ state_config_theme_spacing_small: state.config.theme.spacing.small, state_config_theme_spacing_medium: state.config.theme.spacing.medium, state_config_theme_spacing_large: state.config.theme.spacing.large }, ({ state_config_theme_spacing_small: _v1, state_config_theme_spacing_medium: _v2, state_config_theme_spacing_large: _v3 }) => _v1 + _v2 + _v3)} total</p>

        {/* Boolean expressions with multiple properties */}
        <p>Features: {commontools_1.ifElse(commontools_1.derive({ state_config_features_darkMode: state.config.features.darkMode, state_config_features_animations: state.config.features.animations }, ({ state_config_features_darkMode: _v1, state_config_features_animations: _v2 }) => _v1 && _v2), "Full features", "Limited features")}</p>

        <h3>Method Calls on Shared Bases</h3>
        {/* Multiple method calls on properties from same base */}
        <p>Formatted: {commontools_1.derive(state.user.name, _v1 => _v1.toUpperCase())} - {commontools_1.derive(state.user.email, _v1 => _v1.toLowerCase())}</p>

        {/* Property access and method calls mixed */}
        <p>Profile length: {state.user.profile.bio.length} chars in bio, {state.user.profile.location.length} chars in location</p>

        <h3>Edge Cases for Parent Suppression</h3>
        {/* Same intermediate parent used differently */}
        <p>User settings: Theme is {state.user.settings.theme} with privacy {state.user.settings.privacy}</p>

        {/* Parent and child both used */}
        <p>Data summary: {state.data.items.length} items with average {state.data.totals.average}</p>

        {/* Multiple levels of the same chain */}
        <p>Nested refs: {state.config.theme.colors.primary} in {state.config.theme.fonts.body} with {commontools_1.ifElse(state.config.features.animations, "animations", "no animations")}</p>

        <h3>Extreme Parent Suppression Test</h3>
        {/* Using every level of a deep chain */}
        <p>All levels:
          Root: {commontools_1.ifElse(state.deeply, "exists", "missing")},
          Nested: {commontools_1.ifElse(state.deeply.nested, "exists", "missing")},
          Value: {state.deeply.nested.structure.with.many.levels.value}
        </p>
      </div>),
    };
});

