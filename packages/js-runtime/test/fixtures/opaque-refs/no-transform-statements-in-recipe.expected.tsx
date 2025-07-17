/// <cts-enable />
// Test to verify that OpaqueRef operations in statements are NOT transformed
// Only JSX expressions should be transformed
import { recipe, UI, handler, derive, toSchema, JSONSchema, ifElse } from "commontools";
interface State {
    count: number;
    visible: boolean;
    items: string[];
}
const increment = handler({
    type: "object",
    additionalProperties: true
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number"
        },
        visible: {
            type: "boolean"
        },
        items: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["count", "visible", "items"]
} as const satisfies JSONSchema, (e, state: State) => {
    // These should work fine in handlers (state is not OpaqueRef here)
    if (state.count > 10) {
        state.count = 0;
    }
    state.count++;
});
export default recipe({
    type: "object",
    properties: {
        count: {
            type: "number"
        },
        visible: {
            type: "boolean"
        },
        items: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["count", "visible", "items"]
} as const satisfies JSONSchema, "NoTransformStatements", (state) => {
    // These statement-level operations should NOT be transformed
    // They will fail at runtime if they try to use OpaqueRef directly
    // If statements - NOT transformed
    if (state.count > 10) {
        console.log("Count is high");
    }
    // Variable declarations - NOT transformed
    const isHigh = state.count > 10;
    const double = state.count * 2;
    const message = "Count: " + state.count;
    // Loops - NOT transformed
    for (let i = 0; i < state.count; i++) {
        console.log(i);
    }
    while (state.count < 5) {
        break; // This would fail at runtime
    }
    // Switch statements - NOT transformed
    switch (state.count) {
        case 5:
            console.log("Five");
            break;
        default:
            console.log("Other");
    }
    // Ternary in statements - NOT transformed
    const status = state.visible ? "visible" : "hidden";
    // Function calls with OpaqueRef - NOT transformed
    console.log(state.count);
    alert(state.visible);
    // Array operations - NOT transformed
    const doubled = state.items.map(item => item + "!");
    const filtered = state.items.filter(item => item.length > 5);
    return {
        [UI]: (<div>
        {/* These JSX expressions SHOULD be transformed */}
        <p>Count: {state.count}</p>
        <p>Double: {derive(state.count, _v1 => _v1 * 2)}</p>
        <p>Is High: {ifElse(commontools_1.derive(state.count, _v1 => _v1 > 10), "Yes", "No")}</p>
        <p>Items: {derive(state.items, _v1 => _v1.length)}</p>
        <button onClick={increment(state)}>Increment</button>
      </div>)
    };
});