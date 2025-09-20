/// <cts-enable />
import { h, recipe, UI, derive, JSONSchema } from "commontools";
export default recipe({
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies JSONSchema, (cell) => {
    return {
        [UI]: (<div>
        <p>Current value: {cell.value}</p>
        <p>Next value: {derive(cell.value, _v1 => _v1 + 1)}</p>
        <p>Double: {derive(cell.value, _v1 => _v1 * 2)}</p>
      </div>),
        value: cell.value,
    };
});
