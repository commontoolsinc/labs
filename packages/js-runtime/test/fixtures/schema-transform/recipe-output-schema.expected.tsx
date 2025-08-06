/// <cts-enable />
import { recipe, Cell, UI, NAME, h, derive, JSONSchema } from "commontools";
// Simple types to test recipe output schema transformation
interface RecipeInput {
    name: string;
    count: number;
}
interface RecipeOutput {
    name: string;
    doubled: number;
    message: string;
}
// Recipe with explicit input/output types
export const myRecipe = recipe({
    type: "object",
    properties: {
        name: {
            type: "string"
        },
        count: {
            type: "number"
        }
    },
    required: ["name", "count"]
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        name: {
            type: "string"
        },
        doubled: {
            type: "number"
        },
        message: {
            type: "string"
        }
    },
    required: ["name", "doubled", "message"]
} as const satisfies JSONSchema, ({ name, count }) => {
    const doubled = derive(count, n => n * 2);
    const message = derive(name, n => `Hello, ${n}!`);
    return {
        [NAME]: message,
        [UI]: (<div>
        <h2>{message}</h2>
        <p>Original: {count}</p>
        <p>Doubled: {doubled}</p>
      </div>),
        name,
        doubled,
        message
    };
});