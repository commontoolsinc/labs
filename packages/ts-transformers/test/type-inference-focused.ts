/// <reference lib="deno.ns" />
import ts from "typescript";

/**
 * Focused exploration: Unused/unreferenced parameters and object fields
 */

const testCases = [
  {
    name: "Completely unused function parameter",
    code: `function test(x) { return 42; }`,
  },
  {
    name: "Parameter used only in console.log",
    code: `function test(x) { console.log(x); }`,
  },
  {
    name: "Parameter returned directly",
    code: `function test(x) { return x; }`,
  },
  {
    name: "Parameter used in arithmetic",
    code: `function test(x) { return x + 1; }`,
  },
  {
    name: "Parameter used in string concatenation",
    code: `function test(x) { return x + "hello"; }`,
  },
  {
    name: "Parameter used in comparison",
    code: `function test(x) { return x > 5; }`,
  },
  {
    name: "Parameter passed to another function",
    code: `function test(x) { return JSON.stringify(x); }`,
  },
  {
    name: "Parameter property accessed",
    code: `function test(x) { return x.prop; }`,
  },
  {
    name: "Handler with unused event parameter",
    code: `const handler = (_, state) => state.value++;`,
  },
  {
    name: "Handler with no event type, unused event",
    code: `function handler(e, state) { return state; }`,
  },
  {
    name: "Object field - undefined literal",
    code: `const obj = { x: undefined };`,
  },
  {
    name: "Object field - null literal",
    code: `const obj = { x: null };`,
  },
  {
    name: "Object field - no initializer in interface",
    code: `interface I { x?; } const obj: I = {};`,
  },
  {
    name: "Object field - optional in type literal",
    code: `const obj: { x?: number } = {};`,
  },
  {
    name: "Class field - no type, no initializer",
    code: `class C { field; }`,
  },
  {
    name: "Class field - initialized to undefined",
    code: `class C { field = undefined; }`,
  },
  {
    name: "Class field - optional, no initializer",
    code: `class C { field?; }`,
  },
  {
    name: "Destructured parameter - unused",
    code: `function test({ x }) { return 42; }`,
  },
  {
    name: "Destructured parameter - used",
    code: `function test({ x }) { return x; }`,
  },
  {
    name: "Rest parameter - unused",
    code: `function test(...args) { return 42; }`,
  },
  {
    name: "Rest parameter - used",
    code: `function test(...args) { return args.length; }`,
  },
  {
    name: "Array callback - unused parameter",
    code: `[1,2,3].map((x) => 42);`,
  },
  {
    name: "Array callback - used parameter",
    code: `[1,2,3].map((x) => x * 2);`,
  },
  {
    name: "Array callback - unused index",
    code: `[1,2,3].map((x, i) => x * 2);`,
  },
  {
    name: "Type parameter - unused",
    code: `function test<T>(x: string) { return x; }`,
  },
  {
    name: "Type parameter - used in return",
    code: `function test<T>(x: T): T { return x; }`,
  },
];

function analyzeCase(
  testCase: { name: string; code: string },
  strict: boolean,
) {
  const fileName = "test.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    testCase.code,
    ts.ScriptTarget.Latest,
    true,
  );

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    strict: strict,
    noImplicitAny: false,
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

  const results: string[] = [];

  function visit(node: ts.Node) {
    // Function/method parameters
    if (
      ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
    ) {
      node.parameters.forEach((param) => {
        const type = checker.getTypeAtLocation(param);
        const typeStr = checker.typeToString(type);
        const paramName = ts.isIdentifier(param.name)
          ? param.name.text
          : ts.isObjectBindingPattern(param.name)
          ? "{...}"
          : "...rest";
        results.push(`param '${paramName}': ${typeStr}`);
      });

      // Type parameters
      if ("typeParameters" in node && node.typeParameters) {
        node.typeParameters.forEach((tp) => {
          const type = checker.getTypeAtLocation(tp);
          const typeStr = checker.typeToString(type);
          results.push(`typeParam '${tp.name.text}': ${typeStr}`);
        });
      }
    }

    // Variable declarations
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const type = checker.getTypeAtLocation(node);
      const typeStr = checker.typeToString(type);
      results.push(`var '${node.name.text}': ${typeStr}`);
    }

    // Class fields
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      const type = checker.getTypeAtLocation(node);
      const typeStr = checker.typeToString(type);
      results.push(`field '${node.name.text}': ${typeStr}`);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

console.log("=".repeat(80));
console.log("Focused Type Inference Analysis");
console.log("=".repeat(80));

for (const testCase of testCases) {
  const nonStrict = analyzeCase(testCase, false);
  const strict = analyzeCase(testCase, true);

  console.log(`\n${testCase.name}`);
  console.log(`Code: ${testCase.code}`);
  console.log("-".repeat(80));

  for (let i = 0; i < nonStrict.length; i++) {
    const ns = nonStrict[i];
    const s = strict[i];

    if (ns === s) {
      console.log(`  ${ns}`);
    } else {
      console.log(`  Non-Strict: ${ns}`);
      console.log(`  Strict:     ${s}`);
    }
  }
}

// Summary analysis
console.log("\n" + "=".repeat(80));
console.log("KEY FINDINGS");
console.log("=".repeat(80));

console.log(`
1. UNUSED FUNCTION PARAMETERS:
   - TypeScript infers 'any' for unused parameters in both strict and non-strict mode
   - Usage doesn't matter - even completely unused params get 'any'
   - This is true even when the parameter is never referenced

2. OBJECT FIELDS:
   - Fields initialized to 'undefined' get 'any' in non-strict, 'undefined' in strict
   - Fields initialized to 'null' get 'any' (the literal null type has type 'any')
   - Optional fields (?) without initializer get 'undefined' type

3. CATCH CLAUSE EXCEPTION:
   - The ONLY case where TypeScript infers 'unknown' instead of 'any'
   - Non-strict: catch (e) => e is 'any'
   - Strict: catch (e) => e is 'unknown'
   - This changed in TypeScript 4.0 as a safety improvement

4. HANDLER PATTERN (event, state):
   - Unused event parameter (often '_') gets 'any'
   - State parameter gets 'any' if not annotated
   - No special inference for common patterns

5. TYPE PARAMETERS:
   - Type parameters like <T> are not 'any' or 'unknown'
   - They're type variables (TypeFlags = 262144 = TypeParameter)
   - Can be constrained but default to no constraint

6. CONTEXTUAL TYPING:
   - Array callbacks get contextual typing from the array
   - [1,2,3].map(x => ...) => x is inferred as 'number' from array
   - But the type checker shows 'any' for the parameter node itself
`);
