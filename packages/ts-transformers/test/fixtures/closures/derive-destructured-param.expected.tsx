import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
interface Point {
    x: number;
    y: number;
}
export default function TestDerive() {
    const point = cell({ x: 10, y: 20 } as Point);
    const multiplier = cell(2);
    // Destructured parameter
    const result = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            point: {
                $ref: "#/$defs/Point",
                asOpaque: true
            },
            multiplier: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["point", "multiplier"],
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
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        point,
        multiplier: multiplier
    }, ({ point: { x, y }, multiplier }) => (x + y) * multiplier.get());
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
