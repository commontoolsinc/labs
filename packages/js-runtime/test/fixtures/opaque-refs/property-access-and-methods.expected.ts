import { cell, derive } from "commontools";
interface User {
    name: string;
    age: number;
}
const person = cell<User>({
    name: "John",
    age: 25
});
// Direct property access on OpaqueRef<User> - should NOT be transformed (just accessing)
const personRef = person;
// Property access - these return OpaqueRef values, should NOT be transformed when just accessing
const userName = person.name;
const userAge = person.age;
// Operations on OpaqueRef properties - SHOULD be transformed
const nextAge = commontools_1.derive(person.age, _v1 => _v1 + 1);
const ageInMonths = commontools_1.derive(person.age, _v1 => _v1 * 12);
// Method calls on OpaqueRef<string> - SHOULD be transformed
const upperName = commontools_1.derive(person.name, _v1 => _v1.toUpperCase());
const nameLength = commontools_1.derive(person.name, _v1 => _v1.length);
// Function calls with OpaqueRef properties - SHOULD be transformed
const roundedAge = commontools_1.derive(person.age, _v1 => Math.round(_v1));
const maxAge = commontools_1.derive(person.age, _v1 => Math.max(_v1, 30));
// Complex expressions
const greeting = commontools_1.derive(person.name, _v1 => "Hello, " + _v1);
const ageCheck = commontools_1.derive(person.age, _v1 => _v1 > 18);