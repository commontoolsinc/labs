import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>String Concatenation</h3>
        <h1>{__ctHelpers.derive({ state: {
                title: state.title,
                firstName: state.firstName,
                lastName: state.lastName
            } }, ({ state }) => state.title + ": " + state.firstName + " " + state.lastName)}</h1>
        <p>{__ctHelpers.derive({ state: {
                firstName: state.firstName,
                lastName: state.lastName
            } }, ({ state }) => state.firstName + state.lastName)}</p>
        <p>{__ctHelpers.derive({ state: {
                firstName: state.firstName
            } }, ({ state }) => "Hello, " + state.firstName + "!")}</p>

        <h3>Template Literals</h3>
        <p>{__ctHelpers.derive({ state: {
                firstName: state.firstName
            } }, ({ state }) => `Welcome, ${state.firstName}!`)}</p>
        <p>{__ctHelpers.derive({ state: {
                firstName: state.firstName,
                lastName: state.lastName
            } }, ({ state }) => `Full name: ${state.firstName} ${state.lastName}`)}</p>
        <p>{__ctHelpers.derive({ state: {
                title: state.title,
                firstName: state.firstName,
                lastName: state.lastName
            } }, ({ state }) => `${state.title}: ${state.firstName} ${state.lastName}`)}</p>

        <h3>String Methods</h3>
        <p>Uppercase: {__ctHelpers.derive({ state: {
                firstName: state.firstName
            } }, ({ state }) => state.firstName.toUpperCase())}</p>
        <p>Lowercase: {__ctHelpers.derive({ state: {
                title: state.title
            } }, ({ state }) => state.title.toLowerCase())}</p>
        <p>Length: {state.message.length}</p>
        <p>Substring: {__ctHelpers.derive({ state: {
                message: state.message
            } }, ({ state }) => state.message.substring(0, 5))}</p>

        <h3>Mixed String and Number</h3>
        <p>{__ctHelpers.derive({ state: {
                firstName: state.firstName,
                count: state.count
            } }, ({ state }) => state.firstName + " has " + state.count + " items")}</p>
        <p>{__ctHelpers.derive({ state: {
                firstName: state.firstName,
                count: state.count
            } }, ({ state }) => `${state.firstName} has ${state.count} items`)}</p>
        <p>Count as string: {__ctHelpers.derive({ state: {
                count: state.count
            } }, ({ state }) => "Count: " + state.count)}</p>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
