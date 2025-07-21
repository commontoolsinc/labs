/// <cts-enable />
import { JSONSchema } from "commontools";
interface TodoItem {
    title: string;
    done?: boolean;
    tags: string[];
}
const todoSchema = {
    type: "object",
    properties: {
        title: {
            type: "string"
        },
        done: {
            type: "boolean"
        },
        tags: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["title", "tags"]
} as const satisfies JSONSchema;
export { todoSchema };
