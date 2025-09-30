/// <reference lib="deno.ns" />
import ts from "typescript";

/**
 * Test file to explore TypeScript's type inference behavior in underspecified scenarios
 */

const code = `
// ============================================================================
// SCENARIO 1: Unused/unreferenced function parameters
// ============================================================================

// No type annotation, parameter never used
function unusedParam1(x) {
  return 42;
}

// No type annotation, parameter used but no operations that constrain type
function unusedParam2(x) {
  console.log(x);
  return x;
}

// No type annotation, parameter used in generic operation
function unusedParam3(x) {
  return { value: x };
}

// Arrow function with unused parameter
const unusedArrow1 = (x) => 42;

// Arrow function that returns parameter
const unusedArrow2 = (x) => x;

// Multiple parameters, some unused
function mixedUsage(x, y, z) {
  return y + 10;
}

// Callback parameter never annotated
function takesCallback(cb) {
  return cb(5);
}

// ============================================================================
// SCENARIO 2: Object fields without annotations
// ============================================================================

// Empty object literal
const emptyObj = {};

// Object with unannotated field
const objField1 = { x: undefined };

// Object field set to null
const objField2 = { x: null };

// Object with no initializer in interface
interface HasOptional {
  x?;
}

// Object spread with no type
const spread1 = { ...{} };

// Destructured parameter with no type
function destructure1({ x }) {
  return x;
}

// Destructured with default
function destructure2({ x = 5 }) {
  return x;
}

// ============================================================================
// SCENARIO 3: Array operations
// ============================================================================

// Empty array
const emptyArr = [];

// Array with no type annotation
const arr1 = [1, 2, 3];

// Mixed array
const mixedArr = [1, "hello", true];

// Array map with no annotation
const mapped = [1, 2, 3].map(x => x * 2);

// Array map where callback parameter type is ambiguous
const mappedNoType = [1, 2, 3].map(x => ({ value: x }));

// ============================================================================
// SCENARIO 4: Generic functions without constraints
// ============================================================================

// Generic function with no constraints
function identity<T>(x: T): T {
  return x;
}

// Calling identity with no type argument
const inferredIdentity = identity(42);

// Generic with no constraint, parameter unused
function genericUnused<T>(x: T) {
  return "hello";
}

// ============================================================================
// SCENARIO 5: Variable declarations
// ============================================================================

// Variable with no initializer, no type annotation
let uninitVar;

// Variable initialized to undefined
let explicitUndefined = undefined;

// Variable from function with no return type
function noReturn() {
  // no return statement
}
const fromNoReturn = noReturn();

// Variable from void function
function voidFunc(): void {
  console.log("hi");
}
const fromVoid = voidFunc();

// ============================================================================
// SCENARIO 6: Promise and async scenarios
// ============================================================================

// Async function with no return type
async function asyncNoReturn() {
  // no return
}

// Promise with no type argument
const promise1 = new Promise((resolve) => {
  resolve(42);
});

// Promise with resolve but no type
const promise2 = new Promise((resolve, reject) => {
  resolve();
});

// ============================================================================
// SCENARIO 7: Class scenarios
// ============================================================================

class NoFieldTypes {
  // Field with no type annotation
  field1;

  // Field initialized to undefined
  field2 = undefined;

  // Method parameter with no type
  method1(param) {
    return param;
  }

  // Constructor parameter with no type
  constructor(arg) {
    this.field1 = arg;
  }
}

// ============================================================================
// SCENARIO 8: Type assertions and casts
// ============================================================================

// as any
const asAny = 42 as any;

// as unknown
const asUnknown = 42 as unknown;

// Double assertion
const doubleAssert = 42 as unknown as string;

// ============================================================================
// SCENARIO 9: Contextual typing scenarios
// ============================================================================

// Event handler (contextual typing from DOM)
// document.addEventListener("click", (e) => {
//   console.log(e);
// });

// Array methods with contextual typing
const filtered = [1, 2, 3].filter(x => x > 1);

// Reduce with no type annotations
const reduced = [1, 2, 3].reduce((acc, val) => acc + val);

// Reduce with initial value of different type
const reducedObj = [1, 2, 3].reduce((acc, val) => {
  acc[val] = val * 2;
  return acc;
}, {});

// ============================================================================
// SCENARIO 10: Error handling
// ============================================================================

try {
  throw new Error("test");
} catch (e) {
  // What is the type of 'e'?
  console.log(e);
}

// ============================================================================
// SCENARIO 11: Rest parameters and spread
// ============================================================================

// Rest parameter with no type
function restParams(...args) {
  return args;
}

// Destructuring rest
function destructRest({ x, ...rest }) {
  return rest;
}

// ============================================================================
// SCENARIO 12: Index signatures
// ============================================================================

// Object with index signature, no type
const indexed = { [key: string]: undefined };

// Dynamic property access
function getProp(obj, key) {
  return obj[key];
}

// ============================================================================
// SCENARIO 13: Conditional types and inference
// ============================================================================

// Type parameter inference in conditional
type GetReturn<T> = T extends (...args: any[]) => infer R ? R : never;

// Using infer in a function
function inferReturn<T extends (...args: any[]) => any>(fn: T): GetReturn<T> {
  return fn() as GetReturn<T>;
}

// ============================================================================
// SCENARIO 14: Generators
// ============================================================================

function* generatorNoType() {
  yield 1;
  yield 2;
}

function* generatorYieldUnknown() {
  yield;
}
`;

// Create a TypeScript program to analyze these scenarios
const fileName = "test.ts";
const sourceFile = ts.createSourceFile(
  fileName,
  code,
  ts.ScriptTarget.Latest,
  true,
);

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.ESNext,
  strict: false, // Turn off strict mode to allow more inference
  noImplicitAny: false, // Allow implicit any
};

const host = ts.createCompilerHost(options);
host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
host.writeFile = () => {};
host.getCurrentDirectory = () => "";
host.getCanonicalFileName = (name) => name;
host.useCaseSensitiveFileNames = () => true;
host.getNewLine = () => "\n";

const program = ts.createProgram([fileName], options, host);
const checker = program.getTypeChecker();

// Helper to get type information
function analyzeNode(node: ts.Node, name: string) {
  const type = checker.getTypeAtLocation(node);
  const typeString = checker.typeToString(type);
  const flags = type.flags;

  const flagNames: string[] = [];
  if (flags & ts.TypeFlags.Any) flagNames.push("Any");
  if (flags & ts.TypeFlags.Unknown) flagNames.push("Unknown");
  if (flags & ts.TypeFlags.String) flagNames.push("String");
  if (flags & ts.TypeFlags.Number) flagNames.push("Number");
  if (flags & ts.TypeFlags.Boolean) flagNames.push("Boolean");
  if (flags & ts.TypeFlags.Void) flagNames.push("Void");
  if (flags & ts.TypeFlags.Undefined) flagNames.push("Undefined");
  if (flags & ts.TypeFlags.Null) flagNames.push("Null");
  if (flags & ts.TypeFlags.Never) flagNames.push("Never");

  return {
    name,
    typeString,
    flags: flagNames.join(" | ") || `Other (${flags})`,
  };
}

console.log("=".repeat(80));
console.log("TypeScript Type Inference Exploration");
console.log("=".repeat(80));
console.log();

const results: ReturnType<typeof analyzeNode>[] = [];

// Visit all variable declarations and function parameters
function visit(node: ts.Node) {
  // Function parameters
  if (
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    const funcName = ts.isFunctionDeclaration(node) && node.name
      ? node.name.text
      : ts.isVariableDeclaration(node.parent) &&
          ts.isIdentifier(node.parent.name)
      ? node.parent.name.text
      : "anonymous";

    node.parameters.forEach((param, idx) => {
      if (ts.isIdentifier(param.name)) {
        results.push(
          analyzeNode(param, `${funcName}::param[${idx}] '${param.name.text}'`),
        );
      }
    });
  }

  // Variable declarations
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    results.push(analyzeNode(node, `var '${node.name.text}'`));
  }

  // Class fields
  if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
    const className =
      node.parent && ts.isClassDeclaration(node.parent) && node.parent.name
        ? node.parent.name.text
        : "anonymous";
    results.push(analyzeNode(node, `${className}.${node.name.text}`));
  }

  // Catch clause variables
  if (ts.isCatchClause(node) && node.variableDeclaration) {
    const varDecl = node.variableDeclaration;
    if (ts.isIdentifier(varDecl.name)) {
      results.push(analyzeNode(varDecl, `catch '${varDecl.name.text}'`));
    }
  }

  ts.forEachChild(node, visit);
}

visit(sourceFile);

// Group results by category
const scenarios = {
  "Function Parameters (unused/unreferenced)": results.filter((r) =>
    r.name.includes("::param")
  ),
  "Variables": results.filter((r) => r.name.startsWith("var")),
  "Class Fields": results.filter((r) => r.name.includes(".")),
  "Error Handling": results.filter((r) => r.name.startsWith("catch")),
};

for (const [category, items] of Object.entries(scenarios)) {
  if (items.length === 0) continue;

  console.log(`\n${"=".repeat(80)}`);
  console.log(category);
  console.log("=".repeat(80));

  for (const item of items) {
    console.log(`\n${item.name}`);
    console.log(`  Type: ${item.typeString}`);
    console.log(`  Flags: ${item.flags}`);
  }
}

// Summary statistics
console.log(`\n${"=".repeat(80)}`);
console.log("Summary Statistics");
console.log("=".repeat(80));

const anyCount = results.filter((r) => r.flags.includes("Any")).length;
const unknownCount = results.filter((r) => r.flags.includes("Unknown")).length;
const undefinedCount =
  results.filter((r) => r.flags.includes("Undefined")).length;
const voidCount = results.filter((r) => r.flags.includes("Void")).length;
const neverCount = results.filter((r) => r.flags.includes("Never")).length;

console.log(`\nTotal items analyzed: ${results.length}`);
console.log(
  `  'any' type: ${anyCount} (${
    (anyCount / results.length * 100).toFixed(1)
  }%)`,
);
console.log(
  `  'unknown' type: ${unknownCount} (${
    (unknownCount / results.length * 100).toFixed(1)
  }%)`,
);
console.log(
  `  'undefined' type: ${undefinedCount} (${
    (undefinedCount / results.length * 100).toFixed(1)
  }%)`,
);
console.log(
  `  'void' type: ${voidCount} (${
    (voidCount / results.length * 100).toFixed(1)
  }%)`,
);
console.log(
  `  'never' type: ${neverCount} (${
    (neverCount / results.length * 100).toFixed(1)
  }%)`,
);
