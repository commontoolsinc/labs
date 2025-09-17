import { OpaqueRef, recipe, JSONSchema } from "commontools";
interface TodoItem {
    title: string;
    done: boolean;
}
export default recipe({
    $schema: "https://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/definitions/TodoItem"
            }
        }
    },
    required: ["items"],
    definitions: {
        TodoItem: {
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
        }
    }
} as const satisfies JSONSchema, ({ items }) => {
    // This should NOT be transformed to items.get().map()
    // because OpaqueRef has its own map method
    const mapped = items.map((item) => item.title);
    // This should also work without transformation
    const filtered = items.map((item, index) => ({
        title: item.title,
        done: item.done,
        position: index,
    }));
    return { mapped, filtered };
});
