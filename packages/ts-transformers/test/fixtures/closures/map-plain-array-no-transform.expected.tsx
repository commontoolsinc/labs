/// <cts-enable />
import { h, recipe, UI, derive, JSONSchema } from "commontools";
interface State {
    multiplier: number;
}
export default recipe({
    type: "object",
    properties: {
        multiplier: {
            type: "number"
        }
    },
    required: ["multiplier"]
} as const satisfies JSONSchema, (state) => {
    const plainArray = [1, 2, 3, 4, 5];
    return {
        [UI]: (<div>
        {/* Plain array should NOT be transformed, even with captures */}
        {plainArray.map((n) => (<span>{derive({ n, state_multiplier: state.multiplier }, ({ n: n, state_multiplier: _v2 }) => n * _v2)}</span>))}
      </div>),
    };
});
