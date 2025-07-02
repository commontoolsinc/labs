/// <cts-enable />
import { toSchema, JSONSchema } from "commontools";
interface User {
    name: string;
    age: number;
}
const userSchema = {
    type: "object",
    properties: {
        name: {
            type: "string"
        },
        age: {
            type: "number"
        }
    },
    required: ["name", "age"]
} as const satisfies JSONSchema;
export { userSchema };