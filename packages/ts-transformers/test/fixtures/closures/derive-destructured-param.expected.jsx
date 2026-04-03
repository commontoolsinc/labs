import * as __cfHelpers from "commonfabric";
import { Writable, derive, pattern } from "commonfabric";
interface Point {
    x: number;
    y: number;
}
// FIXTURE: derive-destructured-param
// Verifies: a captured cell works alongside destructuring inside the callback body
//   derive(point, fn) → derive(schema, schema, { point, multiplier }, fn)
// Context: `const { x, y } = p.get()` destructures inside the body, not the parameter
export default pattern(() => {
    const point = Writable.of({ x: 10, y: 20 } as Point, {
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
    } as const satisfies __cfHelpers.JSONSchema);
    const multiplier = Writable.of(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    // Destructuring requires .get() first since derive doesn't unwrap Cell
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            point: {
                $ref: "#/$defs/Point",
                asCell: true
            },
            multiplier: {
                type: "number",
                asCell: true
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        point,
        multiplier: multiplier
    }, ({ point: p, multiplier }) => {
        const { x, y } = p.get();
        return (x + y) * multiplier.get();
    });
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
