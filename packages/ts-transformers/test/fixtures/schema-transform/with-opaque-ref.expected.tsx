/// <cts-enable />
import { Cell, derive, h, recipe, UI, JSONSchema } from "commontools";
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
    const doubled = derive({} as const satisfies JSONSchema, {
        type: "number"
    } as const satisfies JSONSchema, cell.value, (v) => v * 2);
    return {
        [UI]: (<div>
        <p>Value: {cell.value}</p>
        <p>Doubled: {doubled}</p>
      </div>),
        value: cell.value,
    };
});
