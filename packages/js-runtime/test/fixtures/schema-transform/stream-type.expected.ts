/// <cts-enable />
import { Stream, JSONSchema } from "commontools";
interface State {
    events: Stream<string>;
    label: string;
}
const stateSchema = {
    type: "object",
    properties: {
        events: {
            type: "string",
            asStream: true
        },
        label: {
            type: "string"
        }
    },
    required: ["events", "label"]
} as const satisfies JSONSchema;
export { stateSchema };