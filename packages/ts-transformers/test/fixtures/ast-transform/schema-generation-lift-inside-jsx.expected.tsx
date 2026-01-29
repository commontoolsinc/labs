import * as __ctHelpers from "commontools";
import { lift } from "commontools";
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
    {__lift_0}
  </div>);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
const __lift_0 = lift({
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
} as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema, (person: Person): PersonWithYear => ({
    name: person.name,
    birthYear: currentYear - person.age,
}));
