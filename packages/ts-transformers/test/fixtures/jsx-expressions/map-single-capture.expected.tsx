import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe("MapSingleCapture", (_state) => {
    const people = cell([
        { id: "1", name: "Alice" },
        { id: "2", name: "Bob" },
    ]);
    return {
        [UI]: (<div>
        {__ctHelpers.derive(people, people => people.length > 0 && (<ul>
            {people.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/__object"
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"],
                $defs: {
                    __object: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string"
                            },
                            name: {
                                type: "string"
                            }
                        },
                        required: ["id", "name"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element, params: {} }) => (<li key={element.id}>{element.name}</li>)), {})}
          </ul>))}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
