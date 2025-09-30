/// <reference lib="deno.ns" />
import ts from "typescript";

/**
 * Test TypeScript inference with STRICT mode enabled
 * Compare to non-strict mode to see differences
 */

const code = `
// Test cases that behave differently in strict vs non-strict mode

// 1. Unused function parameter
function unusedParam(x) {
  return 42;
}

// 2. Catch clause variable
try {
  throw new Error("test");
} catch (e) {
  console.log(e);
}

// 3. Callback with no annotation
[1, 2, 3].forEach(function(item) {
  console.log(item);
});

// 4. Variable with no initializer
let noInit;

// 5. Class field with no type
class TestClass {
  field;

  constructor(arg) {
    this.field = arg;
  }
}

// 6. Object with undefined property
const obj = { x: undefined };

// 7. Empty array
const arr = [];

// 8. Promise executor parameters
new Promise((resolve, reject) => {
  resolve(42);
});

// 9. Generic function parameter
function identity<T>(x: T) {
  return x;
}

// 10. Rest parameters
function rest(...args) {
  return args;
}
`;

function analyzeWithMode(strict: boolean) {
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
    strict: strict,
    noImplicitAny: false, // Still allow implicit any even in strict mode
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

  const results: Array<
    { name: string; typeString: string; isAny: boolean; isUnknown: boolean }
  > = [];

  function visit(node: ts.Node) {
    if (
      ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      const funcName = ts.isFunctionDeclaration(node) && node.name
        ? node.name.text
        : "anonymous";

      node.parameters.forEach((param) => {
        if (ts.isIdentifier(param.name)) {
          const type = checker.getTypeAtLocation(param);
          results.push({
            name: `${funcName}::${param.name.text}`,
            typeString: checker.typeToString(type),
            isAny: !!(type.flags & ts.TypeFlags.Any),
            isUnknown: !!(type.flags & ts.TypeFlags.Unknown),
          });
        }
      });
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const type = checker.getTypeAtLocation(node);
      results.push({
        name: `var::${node.name.text}`,
        typeString: checker.typeToString(type),
        isAny: !!(type.flags & ts.TypeFlags.Any),
        isUnknown: !!(type.flags & ts.TypeFlags.Unknown),
      });
    }

    if (ts.isCatchClause(node) && node.variableDeclaration) {
      const varDecl = node.variableDeclaration;
      if (ts.isIdentifier(varDecl.name)) {
        const type = checker.getTypeAtLocation(varDecl);
        results.push({
          name: `catch::${varDecl.name.text}`,
          typeString: checker.typeToString(type),
          isAny: !!(type.flags & ts.TypeFlags.Any),
          isUnknown: !!(type.flags & ts.TypeFlags.Unknown),
        });
      }
    }

    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      const className =
        node.parent && ts.isClassDeclaration(node.parent) && node.parent.name
          ? node.parent.name.text
          : "anonymous";
      const type = checker.getTypeAtLocation(node);
      results.push({
        name: `${className}.${node.name.text}`,
        typeString: checker.typeToString(type),
        isAny: !!(type.flags & ts.TypeFlags.Any),
        isUnknown: !!(type.flags & ts.TypeFlags.Unknown),
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

console.log("=".repeat(80));
console.log("TypeScript Type Inference: Strict vs Non-Strict Mode Comparison");
console.log("=".repeat(80));

const nonStrictResults = analyzeWithMode(false);
const strictResults = analyzeWithMode(true);

console.log("\n" + "=".repeat(80));
console.log("COMPARISON TABLE");
console.log("=".repeat(80));
console.log(
  "\nIdentifier                          | Non-Strict Mode | Strict Mode",
);
console.log("-".repeat(80));

for (let i = 0; i < nonStrictResults.length; i++) {
  const nonStrict = nonStrictResults[i];
  const strict = strictResults[i];

  const identifier = nonStrict.name.padEnd(35);
  const nonStrictType = nonStrict.typeString.padEnd(15);
  const strictType = strict.typeString.padEnd(15);

  const diff = nonStrict.typeString !== strict.typeString
    ? " ⚠️ DIFFERENT"
    : "";

  console.log(`${identifier} | ${nonStrictType} | ${strictType}${diff}`);
}

console.log("\n" + "=".repeat(80));
console.log("SUMMARY");
console.log("=".repeat(80));

const nonStrictAny = nonStrictResults.filter((r) => r.isAny).length;
const strictAny = strictResults.filter((r) => r.isAny).length;
const nonStrictUnknown = nonStrictResults.filter((r) => r.isUnknown).length;
const strictUnknown = strictResults.filter((r) => r.isUnknown).length;

console.log(`\nNon-Strict Mode:`);
console.log(
  `  'any' inferences: ${nonStrictAny} / ${nonStrictResults.length} (${
    (nonStrictAny / nonStrictResults.length * 100).toFixed(1)
  }%)`,
);
console.log(
  `  'unknown' inferences: ${nonStrictUnknown} / ${nonStrictResults.length} (${
    (nonStrictUnknown / nonStrictResults.length * 100).toFixed(1)
  }%)`,
);

console.log(`\nStrict Mode:`);
console.log(
  `  'any' inferences: ${strictAny} / ${strictResults.length} (${
    (strictAny / strictResults.length * 100).toFixed(1)
  }%)`,
);
console.log(
  `  'unknown' inferences: ${strictUnknown} / ${strictResults.length} (${
    (strictUnknown / strictResults.length * 100).toFixed(1)
  }%)`,
);

// Find specific cases where strict mode changes behavior
console.log("\n" + "=".repeat(80));
console.log("NOTABLE DIFFERENCES");
console.log("=".repeat(80));

const differences = [];
for (let i = 0; i < nonStrictResults.length; i++) {
  const nonStrict = nonStrictResults[i];
  const strict = strictResults[i];

  if (nonStrict.typeString !== strict.typeString) {
    differences.push({
      name: nonStrict.name,
      nonStrict: nonStrict.typeString,
      strict: strict.typeString,
    });
  }
}

if (differences.length === 0) {
  console.log("\nNo differences found between strict and non-strict modes.");
} else {
  for (const diff of differences) {
    console.log(`\n${diff.name}:`);
    console.log(`  Non-Strict: ${diff.nonStrict}`);
    console.log(`  Strict:     ${diff.strict}`);
  }
}

// Check for unknown inference
console.log("\n" + "=".repeat(80));
console.log("CASES WHERE 'unknown' IS INFERRED");
console.log("=".repeat(80));

const unknownCases = [...nonStrictResults, ...strictResults].filter((r) =>
  r.isUnknown
);
if (unknownCases.length === 0) {
  console.log("\nNo cases where 'unknown' was inferred.");
  console.log(
    "TypeScript strongly prefers 'any' for implicit/underspecified types.",
  );
} else {
  for (const unk of unknownCases) {
    console.log(`\n${unk.name}: ${unk.typeString}`);
  }
}
