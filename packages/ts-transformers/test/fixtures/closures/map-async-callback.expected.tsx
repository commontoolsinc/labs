/// <cts-enable />
import { h, recipe, UI, JSONSchema } from "commontools";
interface Item {
    id: number;
    url: string;
}
interface State {
    items: Item[];
    apiKey: string;
}
export default recipe({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        apiKey: {
            type: "string"
        }
    },
    required: ["items", "apiKey"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                url: {
                    type: "string"
                }
            },
            required: ["id", "url"]
        }
    }
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {/* Async callback with capture - should still transform */}
        {state.items.map(recipe(async ({ elem, params: { apiKey } }) => (<div>
            Fetching {elem.url} with key: {apiKey}
          </div>)), { apiKey: state.apiKey })}
      </div>),
    };
});
