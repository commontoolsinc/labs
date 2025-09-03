/// <cts-enable />
import { Cell, Stream, Default, JSONSchema, recipe } from "commontools";
// Type aliases for Cell
type MyCell<T> = Cell<T>;
type StringCell = Cell<string>;
type NumberCell = Cell<number>;
// Type aliases for Stream
type MyStream<T> = Stream<T>;
type EventStream = Stream<{
    type: string;
    data: any;
}>;
// Type alias for Default
type WithDefault<T, V extends T> = Default<T, V>;
// Complex type aliases
type CellArray<T> = Cell<T[]>;
type StreamOfCells<T> = Stream<Cell<T>>;
interface TypeAliasTest {
    // Basic type aliases
    genericCell: MyCell<string>;
    specificCell: StringCell;
    numberCell: NumberCell;
    // Arrays of type aliases
    cellArray: MyCell<boolean>[];
    stringCells: StringCell[];
    // Stream aliases
    genericStream: MyStream<number>;
    eventStream: EventStream;
    // Default alias
    withDefault: WithDefault<string, "hello">;
    // Complex aliases
    cellOfArray: CellArray<number>;
    streamOfCells: StreamOfCells<string>;
    // Nested arrays
    nestedAlias: MyCell<MyCell<string>[]>[];
}
const schema = {
    type: "object",
    properties: {
        genericCell: {
            type: "string",
            asCell: true
        },
        specificCell: {
            type: "string",
            asCell: true
        },
        numberCell: {
            type: "number",
            asCell: true
        },
        cellArray: {
            type: "array",
            items: {
                type: "boolean",
                asCell: true
            }
        },
        stringCells: {
            type: "array",
            items: {
                type: "string",
                asCell: true
            }
        },
        genericStream: {
            type: "number",
            asStream: true
        },
        eventStream: {
            type: "object",
            properties: {
                type: {
                    type: "string"
                },
                data: {
                    type: "object",
                    additionalProperties: true
                }
            },
            required: ["type", "data"],
            asStream: true
        },
        withDefault: {
            type: "string",
            default: "hello"
        },
        cellOfArray: {
            type: "array",
            items: {
                type: "number"
            },
            asCell: true
        },
        streamOfCells: {
            type: "string",
            asCell: true,
            asStream: true
        },
        nestedAlias: {
            type: "array",
            items: {
                type: "array",
                items: {
                    type: "string",
                    asCell: true
                },
                asCell: true
            }
        }
    },
    required: ["genericCell", "specificCell", "numberCell", "cellArray", "stringCells", "genericStream", "eventStream", "withDefault", "cellOfArray", "streamOfCells", "nestedAlias"]
} as const satisfies JSONSchema;
export { schema };
// Add a recipe export for ct dev testing
export default recipe("Type Aliases Test", () => {
    return {
        schema,
    };
});
