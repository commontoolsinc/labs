/// <cts-enable />
import { Cell, derive, h, recipe, toSchema, UI } from "commontools";
interface State {
    value: Cell<number>;
}
const model = {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: true
        }
    },
    required: ["value"],
    default: {
        value: 0
    }
} as const satisfies JSONSchema;
export default recipe(model, model, (cell) => {
    const doubled = derive(cell.value, (v) => v * 2);
    return {
        [UI]: (<div>
        <p>Value: {commontools_1.derive(cell, _v1 => _v1.value)}</p>
        <p>Doubled: {doubled}</p>
      </div>),
        value: commontools_1.derive(cell, _v1 => _v1.value),
    };
});
