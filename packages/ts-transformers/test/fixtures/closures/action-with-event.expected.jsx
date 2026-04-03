import * as __cfHelpers from "commonfabric";
import { Cell, pattern, action } from "commonfabric";
interface MyEvent {
    data: string;
}
interface State {
    value: Cell<string>;
}
// FIXTURE: action-with-event
// Verifies: action() with an inline-annotated event parameter generates a typed event schema
//   action((e: MyEvent) => value.set(e.data)) → handler(MyEvent schema, captureSchema, (e, { value }) => ...)({ value })
// Context: Event type from inline annotation (e: MyEvent) rather than generic type parameter
export default pattern((__ct_pattern_input) => {
    const value = __ct_pattern_input.key("value");
    return {
        update: __cfHelpers.handler({
            type: "object",
            properties: {
                data: {
                    type: "string"
                }
            },
            required: ["data"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "object",
            properties: {
                value: {
                    type: "string",
                    asCell: true
                }
            },
            required: ["value"]
        } as const satisfies __cfHelpers.JSONSchema, (e, { value }) => value.set(e.data))({
            value: value
        }),
    };
}, {
    type: "object",
    properties: {
        value: {
            type: "string",
            asCell: true
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
