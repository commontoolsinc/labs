/// <cts-enable />
import { h, recipe, UI, JSONSchema } from "commontools";
interface Tag {
    id: number;
    name: string;
}
interface Item {
    id: number;
    name: string;
    tags: Tag[];
}
interface State {
    items: Item[];
    prefix: string;
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
        }
    },
    required: ["items", "prefix"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                },
                tags: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Tag"
                    }
                }
            },
            required: ["id", "name", "tags"]
        },
        Tag: {
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
        {/* Outer map captures state.prefix, inner map closes over item from outer callback */}
        {state.items.map(recipe(({ elem, params: { prefix } }) => (<div>
            {prefix}: {elem.name}
            <ul>
              {elem.tags.map(recipe(({ elem, params: { name } }) => (<li>{name} - {elem.name}</li>)), { name: elem.name })}
            </ul>
          </div>)), { prefix: state.prefix })}
      </div>),
    };
});
