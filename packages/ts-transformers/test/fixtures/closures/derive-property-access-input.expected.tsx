import * as __ctHelpers from "commontools";
import { cell } from "commontools";
interface State {
    value: number;
}
export default function TestDerive(state: State) {
    const cellValue = cell(state.value);
    const multiplier = cell(2);
    const result = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            cellValue: {
                type: "number",
                asOpaque: true
            },
            multiplier: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["cellValue", "multiplier"]
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        cellValue,
        multiplier: multiplier
    }, ({ cellValue: v, multiplier }) => v * multiplier.get());
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
