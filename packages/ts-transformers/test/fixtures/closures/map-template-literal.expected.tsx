/// <cts-enable />
import { h, recipe, UI, JSONSchema } from "commontools";
interface Item {
    id: number;
    name: string;
}
interface State {
    items: Item[];
    prefix: string;
    suffix: string;
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
        prefix: {
            type: "string"
        },
        suffix: {
            type: "string"
        }
    },
    required: ["items", "prefix", "suffix"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
        }
    }
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {/* Template literal with captures */}
        {state.items.map_with_pattern(recipe(({ elem, params: { prefix, suffix } }) => (<div>{`${prefix} ${elem.name} ${suffix}`}</div>)), { prefix: state.prefix, suffix: state.suffix })}
      </div>),
    };
});
