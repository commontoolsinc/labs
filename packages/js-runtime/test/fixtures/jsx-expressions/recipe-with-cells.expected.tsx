/// <cts-enable />
import { derive, h, recipe, schema, UI } from "commontools";
const model = schema({
    type: "object",
    properties: {
        value: { type: "number", default: 0, asCell: true },
    },
    default: { value: 0 },
});
export default recipe(model, model, (cell) => {
    return {
        [UI]: (<div>
        <p>Current value: {cell.value}</p>
        <p>Next value: {commontools_1.derive(cell.value, _v1 => _v1 + 1)}</p>
        <p>Double: {commontools_1.derive(cell.value, _v1 => _v1 * 2)}</p>
      </div>),
        value: cell.value,
    };
});