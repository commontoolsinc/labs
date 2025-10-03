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
        {state.points.map_with_pattern(recipe(({ elem, params: { scale } }) => (<div>
            Point: ({elem.x * scale}, {elem.y * scale})
          </div>)), { scale: state.scale })}
      </div>),
    };
});
