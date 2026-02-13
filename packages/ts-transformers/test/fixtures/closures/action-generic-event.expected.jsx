import * as __ctHelpers from "commontools";
import { Cell, pattern, action } from "commontools";
interface MyEvent {
    data: string;
}
interface State {
    value: Cell<string>;
}
export default pattern({
    type: "object",
    properties: {
        value: {
            type: "string",
            asCell: true
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        update: {
            $ref: "#/$defs/MyEvent",
            asStream: true
        }
    },
    required: ["update"],
    $defs: {
        MyEvent: {
            type: "object",
            properties: {
                data: {
                    type: "string"
                }
            },
            required: ["data"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, ({ value }) => {
    return {
        // Test action<MyEvent>((e) => ...) variant (type parameter instead of inline annotation)
        update: __ctHelpers.handler({
            type: "object",
            properties: {
                data: {
                    type: "string"
                }
            },
            required: ["data"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "object",
            properties: {
                value: {
                    type: "string",
                    asCell: true
                }
            },
            required: ["value"]
        } as const satisfies __ctHelpers.JSONSchema, (e, { value }) => value.set(e.data))({
            value: value
        }),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
