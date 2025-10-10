import * as __ctHelpers from "commontools";
import { h, recipe, UI } from "commontools";
interface State {
    a: number;
    b: number;
    price: number;
    text: string;
    values: number[];
    name: string;
    float: string;
}
export default recipe({
    type: "object",
    properties: {
        a: {
            type: "number"
        },
        b: {
            type: "number"
        },
        price: {
            type: "number"
        },
        text: {
            type: "string"
        },
        values: {
            type: "array",
            items: {
                type: "number"
            }
        },
        name: {
            type: "string"
        },
        float: {
            type: "string"
        }
    },
    required: ["a", "b", "price", "text", "values", "name", "float"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Math Functions</h3>
        <p>Max: {__ctHelpers.derive({ state_a: state.a, state_b: state.b }, ({ state_a: _v1, state_b: _v2 }) => Math.max(_v1, _v2))}</p>
        <p>Min: {__ctHelpers.derive(state.a, _v1 => Math.min(_v1, 10))}</p>
        <p>Abs: {__ctHelpers.derive({ state_a: state.a, state_b: state.b }, ({ state_a: _v1, state_b: _v2 }) => Math.abs(_v1 - _v2))}</p>
        <p>Round: {__ctHelpers.derive(state.price, _v1 => Math.round(_v1))}</p>
        <p>Floor: {__ctHelpers.derive(state.price, _v1 => Math.floor(_v1))}</p>
        <p>Ceiling: {__ctHelpers.derive(state.price, _v1 => Math.ceil(_v1))}</p>
        <p>Square root: {__ctHelpers.derive(state.a, _v1 => Math.sqrt(_v1))}</p>
        
        <h3>String Methods as Function Calls</h3>
        <p>Uppercase: {__ctHelpers.derive(state.name, _v1 => _v1.toUpperCase())}</p>
        <p>Lowercase: {__ctHelpers.derive(state.name, _v1 => _v1.toLowerCase())}</p>
        <p>Substring: {__ctHelpers.derive(state.text, _v1 => _v1.substring(0, 5))}</p>
        <p>Replace: {__ctHelpers.derive(state.text, _v1 => _v1.replace("old", "new"))}</p>
        <p>Includes: {__ctHelpers.ifElse(__ctHelpers.derive(state.text, _v1 => _v1.includes("test")), "Yes", "No")}</p>
        <p>Starts with: {__ctHelpers.ifElse(__ctHelpers.derive(state.name, _v1 => _v1.startsWith("A")), "Yes", "No")}</p>
        
        <h3>Number Methods</h3>
        <p>To Fixed: {__ctHelpers.derive(state.price, _v1 => _v1.toFixed(2))}</p>
        <p>To Precision: {__ctHelpers.derive(state.price, _v1 => _v1.toPrecision(4))}</p>
        
        <h3>Parse Functions</h3>
        <p>Parse Int: {__ctHelpers.derive(state.float, _v1 => parseInt(_v1))}</p>
        <p>Parse Float: {__ctHelpers.derive(state.float, _v1 => parseFloat(_v1))}</p>
        
        <h3>Array Method Calls</h3>
        <p>Sum: {__ctHelpers.derive(state.values, _v1 => _v1.reduce((a, b) => a + b, 0))}</p>
        <p>Max value: {__ctHelpers.derive(state.values, _v1 => Math.max(..._v1))}</p>
        <p>Joined: {__ctHelpers.derive(state.values, _v1 => _v1.join(", "))}</p>
        
        <h3>Complex Function Calls</h3>
        <p>Multiple args: {__ctHelpers.derive(state.a, _v1 => Math.pow(_v1, 2))}</p>
        <p>Nested calls: {__ctHelpers.derive(state.a, _v1 => Math.round(Math.sqrt(_v1)))}</p>
        <p>Chained calls: {__ctHelpers.derive(state.name, _v1 => _v1.trim().toUpperCase())}</p>
        <p>With expressions: {__ctHelpers.derive({ state_a: state.a, state_b: state.b }, ({ state_a: _v1, state_b: _v2 }) => Math.max(_v1 + 1, _v2 * 2))}</p>
      </div>),
    };
});
__ctHelpers.NAME; // <internals>
