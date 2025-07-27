/// <cts-enable />
import { Cell, Default, JSONSchema } from "commontools";
// Test basic Default type transformation
interface UserSettings {
    theme: Default<string, "dark">;
    fontSize: Default<number, 16>;
    notifications: Default<boolean, true>;
}
const settingsSchema = {
    type: "object",
    properties: {
        theme: {
            type: "string",
            default: "dark"
        },
        fontSize: {
            type: "number",
            default: 16
        },
        notifications: {
            type: "boolean",
            default: true
        }
    },
    required: ["theme", "fontSize", "notifications"]
} as const satisfies JSONSchema;
// Test nested Default types
interface AppConfig {
    user: {
        name: string;
        settings: {
            language: Default<string, "en">;
            timezone: Default<string, "UTC">;
        };
    };
    features: {
        darkMode: Default<boolean, false>;
        autoSave: Default<boolean, true>;
    };
}
const appConfigSchema = {
    type: "object",
    properties: {
        user: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                settings: {
                    type: "object",
                    properties: {
                        language: {
                            type: "string",
                            default: "en"
                        },
                        timezone: {
                            type: "string",
                            default: "UTC"
                        }
                    },
                    required: ["language", "timezone"]
                }
            },
            required: ["name", "settings"]
        },
        features: {
            type: "object",
            properties: {
                darkMode: {
                    type: "boolean",
                    default: false
                },
                autoSave: {
                    type: "boolean",
                    default: true
                }
            },
            required: ["darkMode", "autoSave"]
        }
    },
    required: ["user", "features"]
} as const satisfies JSONSchema;
// Test Default with arrays
interface ListConfig {
    items: Default<string[], [
        "item1",
        "item2"
    ]>;
    selectedIndices: Default<number[], [
        0
    ]>;
}
const listConfigSchema = {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            },
            default: ["item1", "item2"]
        },
        selectedIndices: {
            type: "array",
            items: {
                type: "number"
            },
            default: [0]
        }
    },
    required: ["items", "selectedIndices"]
} as const satisfies JSONSchema;
// Test Default with objects
interface ComplexDefault {
    metadata: Default<{
        version: number;
        author: string;
    }, {
        version: 1;
        author: "system";
    }>;
    config: Default<{
        enabled: boolean;
        value: number;
    }, {
        enabled: true;
        value: 100;
    }>;
}
const complexDefaultSchema = {
    type: "object",
    properties: {
        metadata: {
            type: "object",
            properties: {
                version: {
                    type: "number"
                },
                author: {
                    type: "string"
                }
            },
            required: ["version", "author"],
            default: {
                version: 1,
                author: "system"
            }
        },
        config: {
            type: "object",
            properties: {
                enabled: {
                    type: "boolean"
                },
                value: {
                    type: "number"
                }
            },
            required: ["enabled", "value"],
            default: {
                enabled: true,
                value: 100
            }
        }
    },
    required: ["metadata", "config"]
} as const satisfies JSONSchema;
// Test Default with Cell types
interface CellDefaults {
    counter: Cell<Default<number, 0>>;
    messages: Cell<Default<string[], [
    ]>>;
}
const cellDefaultsSchema = {
    type: "object",
    properties: {
        counter: {
            type: "number",
            default: 0,
            asCell: true
        },
        messages: {
            type: "array",
            items: {
                type: "string"
            },
            default: [],
            asCell: true
        }
    },
    required: ["counter", "messages"]
} as const satisfies JSONSchema;
// Test optional properties with Default
interface OptionalWithDefaults {
    requiredField: string;
    optionalWithDefault?: Default<string, "default value">;
    nestedOptional?: {
        value?: Default<number, 42>;
    };
}
const optionalDefaultsSchema = {
    type: "object",
    properties: {
        requiredField: {
            type: "string"
        },
        optionalWithDefault: {
            type: "string",
            default: "default value"
        },
        nestedOptional: {
            type: "object",
            properties: {
                value: {
                    type: "number",
                    default: 42
                }
            }
        }
    },
    required: ["requiredField"]
} as const satisfies JSONSchema;