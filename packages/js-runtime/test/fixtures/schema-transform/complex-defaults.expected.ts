/// <cts-enable />
import { toSchema, Default } from "@commontools/builder/interface";
import { JSONSchema } from "commontools";
// Test array defaults
interface TodoItem {
    title: string;
    done: boolean;
}
interface WithArrayDefaults {
    // Empty array default
    emptyItems: Default<TodoItem[], [
    ]>;
    // Array with default items
    prefilledItems: Default<string[], [
        "item1",
        "item2"
    ]>;
    // Nested array default
    matrix: Default<number[][], [
        [
            1,
            2
        ],
        [
            3,
            4
        ]
    ]>;
}
// Test object defaults
interface WithObjectDefaults {
    // Object with default values
    config: Default<{
        theme: string;
        count: number;
    }, {
        theme: "dark";
        count: 10;
    }>;
    // Nested object default
    user: Default<{
        name: string;
        settings: {
            notifications: boolean;
            email: string;
        };
    }, {
        name: "Anonymous";
        settings: {
            notifications: true;
            email: "user@example.com";
        };
    }>;
}
// Test null/undefined defaults
interface WithNullDefaults {
    nullable: Default<string | null, null>;
    undefinable: Default<string | undefined, undefined>;
}
// Generate schemas
export const arrayDefaultsSchema = {
    type: "object",
    properties: {
        emptyItems: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    title: {
                        type: "string"
                    },
                    done: {
                        type: "boolean"
                    }
                },
                required: ["title", "done"]
            },
            default: []
        },
        prefilledItems: {
            type: "array",
            items: {
                type: "string"
            },
            default: ["item1", "item2"]
        },
        matrix: {
            type: "array",
            items: {
                type: "array",
                items: {
                    type: "number"
                }
            },
            default: [[1, 2], [3, 4]]
        }
    },
    required: ["emptyItems", "prefilledItems", "matrix"]
} as const satisfies JSONSchema;
export const objectDefaultsSchema = {
    type: "object",
    properties: {
        config: {
            type: "object",
            properties: {
                theme: {
                    type: "string"
                },
                count: {
                    type: "number"
                }
            },
            required: ["theme", "count"],
            default: {
                theme: "dark",
                count: 10
            }
        },
        user: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                settings: {
                    type: "object",
                    properties: {
                        notifications: {
                            type: "boolean"
                        },
                        email: {
                            type: "string"
                        }
                    },
                    required: ["notifications", "email"]
                }
            },
            required: ["name", "settings"],
            default: {
                name: "Anonymous",
                settings: {
                    notifications: true,
                    email: "user@example.com"
                }
            }
        }
    },
    required: ["config", "user"]
} as const satisfies JSONSchema;
export const nullDefaultsSchema = {
    type: "object",
    properties: {
        nullable: {
            oneOf: [{
                    type: "null"
                }, {
                    type: "string"
                }],
            default: null
        },
        undefinable: {
            type: "string"
        }
    },
    required: ["nullable", "undefinable"]
} as const satisfies JSONSchema;