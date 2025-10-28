import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface Point {
    x: number;
    y: number;
}
interface State {
    points: Point[];
    scale: number;
}
export default recipe({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
        points: {
            type: "array",
            items: {
                $ref: "#/$defs/Point"
            }
        },
        scale: {
            type: "number"
        }
    },
    required: ["points", "scale"],
    $defs: {
        Point: {
            type: "object",
            properties: {
                x: {
                    type: "number"
                },
                y: {
                    type: "number"
                }
            },
            required: ["x", "y"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {/* Map with destructured parameter and capture */}
        {state.points.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Point"
                    },
                    params: {
                        type: "object",
                        properties: {
                            scale: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["scale"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Point: {
                        type: "object",
                        properties: {
                            x: {
                                type: "number"
                            },
                            y: {
                                type: "number"
                            }
                        },
                        required: ["x", "y"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element, params: { scale } }) => (<div>
            Point: ({__ctHelpers.derive({ element_x: element.x, scale }, ({ element_x: _v1, scale: scale }) => _v1 * scale)}, {__ctHelpers.derive({ element_y: element.y, scale }, ({ element_y: _v1, scale: scale }) => _v1 * scale)})
          </div>)), { scale: state.scale })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
