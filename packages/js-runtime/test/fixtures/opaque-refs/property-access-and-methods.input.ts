import { cell } from "commontools";

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
const nextAge = person.age + 1;
const ageInMonths = person.age * 12;

// Method calls on OpaqueRef<string> - SHOULD be transformed
const upperName = person.name.toUpperCase();
const nameLength = person.name.length;

// Function calls with OpaqueRef properties - SHOULD be transformed
const roundedAge = Math.round(person.age);
const maxAge = Math.max(person.age, 30);

// Complex expressions
const greeting = "Hello, " + person.name;
const ageCheck = person.age > 18;