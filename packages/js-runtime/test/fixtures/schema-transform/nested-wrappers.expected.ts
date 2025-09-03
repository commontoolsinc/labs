/// <cts-enable />
import { Cell, Stream, Default, recipe, JSONSchema } from "commontools";
// Test nested wrapper types
// Default wrapping Cell - these don't work because Default<T, V> requires V extends T
// and a literal value doesn't extend Cell<T>
interface DefaultCell {
    field1: Default<string, "hello">;
    field2: Default<number, 42>;
}
const defaultCellSchema = {
    type: "object",
    properties: {
        field1: {
            type: "string",
            default: "hello"
        },
        field2: {
            type: "number",
            default: 42
        }
    },
    required: ["field1", "field2"]
} as const satisfies JSONSchema;
// Cell wrapping Default
interface CellOfDefault {
    value: Cell<Default<string, "default">>;
}
const cellOfDefaultSchema = {
    type: "object",
    properties: {
        value: {
            type: "string",
            default: "default",
            asCell: true
        }
    },
    required: ["value"]
} as const satisfies JSONSchema;
// Stream wrapping Default  
interface StreamOfDefault {
    events: Stream<Default<string, "initial">>;
}
const streamOfDefaultSchema = {
    type: "object",
    properties: {
        events: {
            type: "string",
            default: "initial",
            asStream: true
        }
    },
    required: ["events"]
} as const satisfies JSONSchema;
// Array of Cells
interface ArrayOfCells {
    items: Cell<string>[];
}
const arrayOfCellsSchema = {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string",
                asCell: true
            }
        }
    },
    required: ["items"]
} as const satisfies JSONSchema;
// Cell containing array
interface CellOfArray {
    tags: Cell<string[]>;
}
const cellOfArraySchema = {
    type: "object",
    properties: {
        tags: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: true
        }
    },
    required: ["tags"]
} as const satisfies JSONSchema;
// Complex nesting
interface ComplexNesting {
    // Cell containing Default
    cellOfDefault: Cell<Default<string, "default">>;
    // Default containing array
    defaultArray: Default<string[], [
        "a",
        "b"
    ]>;
}
const complexNestingSchema = {
    type: "object",
    properties: {
        cellOfDefault: {
            type: "string",
            default: "default",
            asCell: true
        },
        defaultArray: {
            type: "array",
            items: {
                type: "string"
            },
            default: ["a", "b"]
        }
    },
    required: ["cellOfDefault", "defaultArray"]
} as const satisfies JSONSchema;
export { defaultCellSchema, cellOfDefaultSchema, streamOfDefaultSchema, arrayOfCellsSchema, cellOfArraySchema, complexNestingSchema };
// Add a recipe export for ct dev testing
export default recipe("Nested Wrappers Test", () => {
    return {
        schema: defaultCellSchema,
    };
});
