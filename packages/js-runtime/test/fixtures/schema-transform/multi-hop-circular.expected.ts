/// <cts-enable />
import { JSONSchema, recipe } from "commontools";
// Multi-hop circular reference pattern
interface A {
    b: B;
}
interface B {
    c: C;
}
interface C {
    a: A;
}
const multiHopSchema = {
    $ref: "#/definitions/A",
    $schema: "http://json-schema.org/draft-07/schema#",
    definitions: {
        C: {
            type: "object",
            properties: {
                a: {
                    $ref: "#/definitions/A"
                }
            },
            required: ["a"]
        },
        B: {
            type: "object",
            properties: {
                c: {
                    $ref: "#/definitions/C"
                }
            },
            required: ["c"]
        },
        A: {
            type: "object",
            properties: {
                b: {
                    $ref: "#/definitions/B"
                }
            },
            required: ["b"]
        }
    }
} as const satisfies JSONSchema;
export { multiHopSchema };
// Add a recipe export for ct dev testing
export default recipe("Multi-Hop Circular Reference Test", () => {
    return {
        schema: multiHopSchema,
    };
}); 