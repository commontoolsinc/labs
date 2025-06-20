import { transformSource } from "./test-utils.ts";

// Example source code with OpaqueRef patterns
const exampleSource = `
import { OpaqueRef, h } from "commontools";

interface State {
  count: OpaqueRef<number>;
  isActive: OpaqueRef<boolean>;
  name: OpaqueRef<string>;
}

function MyComponent(state: State) {
  // Ternary operator with OpaqueRef condition
  const status = state.isActive ? "active" : "inactive";
  
  // Binary expressions
  const doubled = state.count * 2;
  const incremented = state.count + 1;
  const greeting = "Hello, " + state.name;
  
  // JSX expressions
  return (
    <div>
      <h1>{greeting}</h1>
      <p>Count: {state.count}</p>
      <p>Doubled: {state.count * 2}</p>
      <p>Status: {status}</p>
      {state.isActive ? <span>Active!</span> : <span>Inactive</span>}
    </div>
  );
}
`;

// Type definitions for commontools
const commonToolsTypes = `
export interface OpaqueRef<T> {
  readonly value: T;
}

export declare function derive<T, U>(
  ref: OpaqueRef<T>,
  fn: (value: T) => U
): OpaqueRef<U>;

export declare function ifElse<T>(
  condition: OpaqueRef<boolean>,
  whenTrue: T,
  whenFalse: T
): T;

export declare function h(tag: any, props: any, ...children: any[]): any;
`;

console.log("=== ORIGINAL SOURCE ===");
console.log(exampleSource);

console.log("\n=== TRANSFORM MODE ===");
try {
  const transformed = transformSource(exampleSource, {
    mode: 'transform',
    types: { "commontools.d.ts": commonToolsTypes },
  });
  console.log(transformed);
} catch (e) {
  console.error("Transform failed:", e);
}

console.log("\n=== ERROR MODE ===");
try {
  transformSource(exampleSource, {
    mode: 'error',
    types: { "commontools.d.ts": commonToolsTypes },
  });
  console.log("No transformations needed!");
} catch (e) {
  console.log("Transformations required:");
  console.log((e as Error).message);
}