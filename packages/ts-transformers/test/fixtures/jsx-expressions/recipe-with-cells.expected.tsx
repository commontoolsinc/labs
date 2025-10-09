import * as __ctHelpers from "commontools";
import { h, recipe, UI } from "commontools";
export default recipe({
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, (cell) => {
    return {
        [UI]: (<div>
        <p>Current value: {cell.value}</p>
        <p>Next value: {__ctHelpers.derive(cell.value, _v1 => _v1 + 1)}</p>
        <p>Double: {__ctHelpers.derive(cell.value, _v1 => _v1 * 2)}</p>
      </div>),
        value: cell.value,
    };
});
__ctHelpers.NAME; // <internals>
