/**
 * Verify null elimination using actual commontools types
 * Run: deno run -A test/fixtures/bug-repro/verify-actual.ts
 */

import ts from "typescript";
import { join } from "@std/path";

const projectRoot = "/Users/gideonwald/coding/common_tools/labs";
const testFile = join(projectRoot, "packages/ts-transformers/test/fixtures/bug-repro/actual-types-repro.ts");

// Parse deno.json for import mappings
const denoJson = JSON.parse(Deno.readTextFileSync(join(projectRoot, "deno.json")));
const imports: Record<string, string> = denoJson.imports || {};

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  paths: {
    "commontools": [join(projectRoot, "packages/api/index.ts")],
  },
  baseUrl: projectRoot,
};

const host = ts.createCompilerHost(compilerOptions);
host.resolveModuleNames = (moduleNames, containingFile, _reusedNames, _redirectedReference, options) => {
  return moduleNames.map((moduleName) => {
    if (imports[moduleName]) {
      const resolvedPath = imports[moduleName].startsWith("./")
        ? join(projectRoot, imports[moduleName])
        : imports[moduleName];
      if (resolvedPath.endsWith(".ts")) {
        return { resolvedFileName: resolvedPath, isExternalLibraryImport: false };
      }
    }
    const resolved = ts.resolveModuleName(moduleName, containingFile, options, host);
    return resolved.resolvedModule;
  });
};

const program = ts.createProgram([testFile], compilerOptions, host);
const checker = program.getTypeChecker();
const sourceFile = program.getSourceFile(testFile)!;

console.log("=== NULL ELIMINATION - ACTUAL COMMONTOOLS TYPES ===\n");

const typesToCheck = [
  "Direct", "DirectInner", "DirectGet",
  "StateRef", "ValueProp", "ValueInner", "ValueGet",
  "RequiredStateRef", "RequiredValueProp", "RequiredValueInner",
];

ts.forEachChild(sourceFile, (node) => {
  if (ts.isTypeAliasDeclaration(node)) {
    const name = node.name.text;
    if (typesToCheck.includes(name)) {
      const type = checker.getTypeAtLocation(node.name);
      const typeString = checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation);

      const hasNull = typeString.includes("null");
      const isInnerType = name.endsWith("Inner") || name.endsWith("Get");
      const _expectNull = name.includes("Value") || name.includes("Direct");

      let status = "";
      if (isInnerType) {
        status = hasNull ? "✓ null PRESERVED" : "✗ null ELIMINATED (BUG!)";
      }

      console.log(`${name}:`);
      console.log(`  ${typeString}`);
      if (status) console.log(`  ${status}`);
      console.log();
    }
  }
});

console.log("=== EXPECTED vs ACTUAL ===");
console.log("For nullable properties (value: string | null):");
console.log("  EXPECTED: Inner type should be 'string | null'");
console.log("  ACTUAL: See above - if it shows just 'string', the bug is confirmed");
