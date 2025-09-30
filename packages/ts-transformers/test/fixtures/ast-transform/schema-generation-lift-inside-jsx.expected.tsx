/// <cts-enable />
import { lift, h, JSONSchema } from "commontools";
interface Person {
    name: string;
    age: number;
}
interface PersonWithYear {
    name: string;
    birthYear: number;
}
const currentYear = 2024;
export const result = (<div>
    {lift({
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
    } as const satisfies JSONSchema, {
        type: "object",
        properties: {
            name: {
                type: "string"
            },
            birthYear: {
                type: "number"
            }
        },
        required: ["name", "birthYear"]
    } as const satisfies JSONSchema, (person: Person): PersonWithYear => ({
        name: person.name,
        birthYear: currentYear - person.age,
    }))}
  </div>);
