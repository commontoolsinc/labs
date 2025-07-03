import { recipe, handler, toSchema, Cell, Stream, JSONSchema } from "commontools";
// Define types using TypeScript - more compact!
interface UpdaterInput {
    newValues: string[];
}
interface RecipeInput {
    values: Cell<string[]>;
}
interface RecipeOutput {
    values: string[];
    updater: Stream<UpdaterInput>;
}
// Transform to schema at compile time
const updaterSchema = {
    type: "object",
    properties: {
        newValues: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["newValues"],
    title: "Update Values",
    description: "Append `newValues` to the list.",
    example: {
        newValues: ["foo", "bar"]
    },
    default: {
        newValues: []
    }
} as const satisfies JSONSchema;
const inputSchema = {
    type: "object",
    properties: {
        values: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: true
        }
    },
    required: ["values"],
    default: {
        values: []
    }
} as const satisfies JSONSchema;
const outputSchema = {
    type: "object",
    properties: {
        values: {
            type: "array",
            items: {
                type: "string"
            }
        },
        updater: { ...{
                type: "object",
                properties: {
                    newValues: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    }
                },
                required: ["newValues"]
            }, asStream: true }
    },
    required: ["values", "updater"]
} as const satisfies JSONSchema;
// Use with handler - type safe!
const updater = handler(updaterSchema, inputSchema, (event: UpdaterInput, state: RecipeInput) => {
    event.newValues.forEach((value) => {
        state.values.push(value);
    });
});
// Example with more complex types
interface User {
    name: string;
    age: number;
    email?: string; // Optional property
    tags: string[];
    metadata: {
        created: Date;
        updated: Date;
    };
}
const userSchema = {
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
        tags: {
            type: "array",
            items: {
                type: "string"
            }
        },
        metadata: {
            type: "object",
            properties: {
                created: {
                    type: "string",
                    format: "date-time"
                },
                updated: {
                    type: "string",
                    format: "date-time"
                }
            },
            required: ["created", "updated"]
        }
    },
    required: ["name", "age", "tags", "metadata"],
    description: "A user in the system"
} as const satisfies JSONSchema;
