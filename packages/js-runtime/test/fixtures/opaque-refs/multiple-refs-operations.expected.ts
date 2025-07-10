/// <cts-enable />
import { cell, derive } from "commontools";
// Basic string concatenation with multiple OpaqueRefs
const firstName = cell("John");
const lastName = cell("Doe");
const fullName = commontools_1.derive({ firstName, lastName }, ({ firstName: _v1, lastName: _v2 }) => _v1 + " " + _v2);
// String template with multiple OpaqueRefs
const greeting = commontools_1.derive({ firstName, lastName }, ({ firstName: _v1, lastName: _v2 }) => `Hello, ${_v1} ${_v2}!`);
// Multiple OpaqueRefs in different operations
const x = cell(10);
const y = cell(20);
const z = cell(30);
// Arithmetic with multiple refs
const sum = commontools_1.derive({ x, y, z }, ({ x: _v1, y: _v2, z: _v3 }) => _v1 + _v2 + _v3);
const product = commontools_1.derive({ x, y, z }, ({ x: _v1, y: _v2, z: _v3 }) => _v1 * _v2 * _v3);
const complex = commontools_1.derive({ x, y, z }, ({ x: _v1, y: _v2, z: _v3 }) => (_v1 + _v2) * _v3 - (_v1 * _v2));
// Boolean operations with multiple refs
const allPositive = commontools_1.derive({ x, y, z }, ({ x: _v1, y: _v2, z: _v3 }) => _v1 > 0 && _v2 > 0 && _v3 > 0);
const anyNegative = commontools_1.derive({ x, y, z }, ({ x: _v1, y: _v2, z: _v3 }) => _v1 < 0 || _v2 < 0 || _v3 < 0);
// Mixed operations
const description = commontools_1.derive({ x, y, z }, ({ x: _v1, y: _v2, z: _v3 }) => `Sum: ${_v1 + _v2 + _v3}, Product: ${_v1 * _v2 * _v3}`);
// TODO(ja): Array operations with OpaqueRef arrays
// const items = cell([1, 2, 3]);
// const doubled = items.map(x => x * 2);  // Not yet supported - needs different transformation approach
// const filtered = items.filter(x => x > 2); // Not yet supported - needs different transformation approach
// TODO(ja): Async operations with OpaqueRef
// const url = cell("https://api.example.com/data");
// const response = await fetch(url); // Not yet supported - async/await with OpaqueRef needs special handling
// Nested object property access with multiple refs
const user1 = cell({ name: "Alice", age: 30 });
const user2 = cell({ name: "Bob", age: 25 });
const combinedAge = commontools_1.derive({ user1_age: user1.age, user2_age: user2.age }, ({ user1_age: _v1, user2_age: _v2 }) => _v1 + _v2);
const nameComparison = commontools_1.derive({ user1_name: user1.name, user2_name: user2.name }, ({ user1_name: _v1, user2_name: _v2 }) => _v1 === _v2);