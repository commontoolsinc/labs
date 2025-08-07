/// <cts-enable />
import { h, recipe, UI, derive, JSONSchema } from "commontools";
interface State {
    firstName: string;
    lastName: string;
    title: string;
    message: string;
    count: number;
}
export default recipe({
    type: "object",
    properties: {
        firstName: {
            type: "string"
        },
        lastName: {
            type: "string"
        },
        title: {
            type: "string"
        },
        message: {
            type: "string"
        },
        count: {
            type: "number"
        }
    },
    required: ["firstName", "lastName", "title", "message", "count"]
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>String Concatenation</h3>
        <h1>{(globalThis.__CT_COMMONTOOLS).derive({ state_title: state.title, state_firstName: state.firstName, state_lastName: state.lastName }, ({ state_title: _v1, state_firstName: _v2, state_lastName: _v3 }) => _v1 + ": " + _v2 + " " + _v3)}</h1>
        <p>{(globalThis.__CT_COMMONTOOLS).derive({ state_firstName: state.firstName, state_lastName: state.lastName }, ({ state_firstName: _v1, state_lastName: _v2 }) => _v1 + _v2)}</p>
        <p>{(globalThis.__CT_COMMONTOOLS).derive(state.firstName, _v1 => "Hello, " + _v1 + "!")}</p>
        
        <h3>Template Literals</h3>
        <p>{(globalThis.__CT_COMMONTOOLS).derive(state.firstName, _v1 => `Welcome, ${_v1}!`)}</p>
        <p>{(globalThis.__CT_COMMONTOOLS).derive({ state_firstName: state.firstName, state_lastName: state.lastName }, ({ state_firstName: _v1, state_lastName: _v2 }) => `Full name: ${_v1} ${_v2}`)}</p>
        <p>{(globalThis.__CT_COMMONTOOLS).derive({ state_title: state.title, state_firstName: state.firstName, state_lastName: state.lastName }, ({ state_title: _v1, state_firstName: _v2, state_lastName: _v3 }) => `${_v1}: ${_v2} ${_v3}`)}</p>
        
        <h3>String Methods</h3>
        <p>Uppercase: {(globalThis.__CT_COMMONTOOLS).derive(state.firstName, _v1 => _v1.toUpperCase())}</p>
        <p>Lowercase: {(globalThis.__CT_COMMONTOOLS).derive(state.title, _v1 => _v1.toLowerCase())}</p>
        <p>Length: {(globalThis.__CT_COMMONTOOLS).derive(state.message, _v1 => _v1.length)}</p>
        <p>Substring: {(globalThis.__CT_COMMONTOOLS).derive(state.message, _v1 => _v1.substring(0, 5))}</p>
        
        <h3>Mixed String and Number</h3>
        <p>{(globalThis.__CT_COMMONTOOLS).derive({ state_firstName: state.firstName, state_count: state.count }, ({ state_firstName: _v1, state_count: _v2 }) => _v1 + " has " + _v2 + " items")}</p>
        <p>{(globalThis.__CT_COMMONTOOLS).derive({ state_firstName: state.firstName, state_count: state.count }, ({ state_firstName: _v1, state_count: _v2 }) => `${_v1} has ${_v2} items`)}</p>
        <p>Count as string: {(globalThis.__CT_COMMONTOOLS).derive(state.count, _v1 => "Count: " + _v1)}</p>
      </div>),
    };
});

