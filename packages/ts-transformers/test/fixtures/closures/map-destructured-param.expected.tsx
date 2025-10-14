/// <cts-enable />
import { h, recipe, UI, JSONSchema } from "commontools";
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
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {/* Map with destructured parameter and capture */}
        {state.points.mapWithPattern(recipe({
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
            } as const satisfies JSONSchema, ({ element, params: { scale } }) => (<div>
            Point: ({element.x * scale}, {element.y * scale})
          </div>)), { scale: state.scale })}
      </div>),
    };
});
