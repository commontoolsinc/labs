/// <cts-enable />
import { recipe, Cell, Stream, JSONSchema } from "commontools";
// Test Cell<any>[]
interface CellAnyArray {
    items: Cell<any>[];
}
const cellAnyArraySchema = {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: true,
                asCell: true
            }
        }
    },
    required: ["items"]
} as const satisfies JSONSchema;
// Test Cell<string>[]
interface CellStringArray {
    values: Cell<string>[];
}
const cellStringArraySchema = {
    type: "object",
    properties: {
        values: {
            type: "array",
            items: {
                type: "string",
                asCell: true
            }
        }
    },
    required: ["values"]
} as const satisfies JSONSchema;
// Test Cell<{ text: string }>[]
interface ComplexCellArray {
    cells: Cell<{
        text: string;
        id: number;
    }>[];
}
const complexCellArraySchema = {
    type: "object",
    properties: {
        cells: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    text: {
                        type: "string"
                    },
                    id: {
                        type: "number"
                    }
                },
                required: ["text", "id"],
                asCell: true
            }
        }
    },
    required: ["cells"]
} as const satisfies JSONSchema;
// Test Cell<string[]> (Cell containing an array)
interface CellContainingArray {
    tags: Cell<string[]>;
}
const cellContainingArraySchema = {
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
// Test Cell<{ items: string[] }[]> (Cell containing array of objects)
interface CellComplexArray {
    data: Cell<{
        items: string[];
        count: number;
    }[]>;
}
const cellComplexArraySchema = {
    type: "object",
    properties: {
        data: {
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
            },
            asCell: true
        }
    },
    required: ["data"]
} as const satisfies JSONSchema;
// Test mixed types with Stream<T>[]
interface MixedArrayTypes {
    cells: Cell<string>[];
    streams: Stream<number>[];
    regularArray: string[];
    nestedCell: Cell<Cell<string>[]>;
}
const mixedArrayTypesSchema = {
    type: "object",
    properties: {
        cells: {
            type: "array",
            items: {
                type: "string",
                asCell: true
            }
        },
        streams: {
            type: "array",
            items: {
                type: "number",
                asStream: true
            }
        },
        regularArray: {
            type: "array",
            items: {
                type: "string"
            }
        },
        nestedCell: {
            type: "array",
            items: {
                type: "string",
                asCell: true
            },
            asCell: true
        }
    },
    required: ["cells", "streams", "regularArray", "nestedCell"]
} as const satisfies JSONSchema;
// Test optional Cell arrays
interface OptionalCellArrays {
    requiredCells: Cell<string>[];
    optionalCells?: Cell<number>[];
}
const optionalCellArraysSchema = {
    type: "object",
    properties: {
        requiredCells: {
            type: "array",
            items: {
                type: "string",
                asCell: true
            }
        },
        optionalCells: {
            type: "array",
            items: {
                type: "number",
                asCell: true
            }
        }
    },
    required: ["requiredCells"]
} as const satisfies JSONSchema;
export { cellAnyArraySchema, cellStringArraySchema, complexCellArraySchema, cellContainingArraySchema, cellComplexArraySchema, mixedArrayTypesSchema, optionalCellArraysSchema };
export default recipe("cell-array-test", () => {
    return {
        cellAnyArraySchema,
        cellStringArraySchema,
        complexCellArraySchema,
        cellContainingArraySchema,
        cellComplexArraySchema,
        mixedArrayTypesSchema,
        optionalCellArraysSchema
    };
});

