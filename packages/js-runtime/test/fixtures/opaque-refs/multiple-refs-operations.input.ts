import { cell } from "commontools";

// Basic string concatenation with multiple OpaqueRefs
const firstName = cell("John");
const lastName = cell("Doe");
const fullName = firstName + " " + lastName;

// String template with multiple OpaqueRefs
const greeting = `Hello, ${firstName} ${lastName}!`;

// Multiple OpaqueRefs in different operations
const x = cell(10);
const y = cell(20);
const z = cell(30);

// Arithmetic with multiple refs
const sum = x + y + z;
const product = x * y * z;
const complex = (x + y) * z - (x * y);

// Boolean operations with multiple refs
const allPositive = x > 0 && y > 0 && z > 0;
const anyNegative = x < 0 || y < 0 || z < 0;

// Mixed operations
const description = `Sum: ${x + y + z}, Product: ${x * y * z}`;

// TODO: Array operations with OpaqueRef arrays
// const items = cell([1, 2, 3]);
// const doubled = items.map(x => x * 2);  // Not yet supported - needs different transformation approach
// const filtered = items.filter(x => x > 2); // Not yet supported - needs different transformation approach

// TODO: Async operations with OpaqueRef
// const url = cell("https://api.example.com/data");
// const response = await fetch(url); // Not yet supported - async/await with OpaqueRef needs special handling

// Nested object property access with multiple refs
const user1 = cell({ name: "Alice", age: 30 });
const user2 = cell({ name: "Bob", age: 25 });
const combinedAge = user1.age + user2.age;
const nameComparison = user1.name === user2.name;