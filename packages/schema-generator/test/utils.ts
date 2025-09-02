import ts from "typescript";

export function createTestProgram(
  code: string,
): { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile } {
  const fileName = "test.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
  );

  const compilerHost: ts.CompilerHost = {
    getSourceFile: (name) => name === fileName ? sourceFile : undefined,
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: () => true,
    readFile: () => "",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
  };

  const program = ts.createProgram([fileName], {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
  }, compilerHost);

  return {
    program,
    checker: program.getTypeChecker(),
    sourceFile: sourceFile!,
  };
}

export function getTypeFromCode(
  code: string,
  typeName: string,
): { type: ts.Type; checker: ts.TypeChecker; typeNode?: ts.TypeNode } {
  const { program, checker, sourceFile } = createTestProgram(code);

  let foundType: ts.Type | undefined;
  let foundTypeNode: ts.TypeNode | undefined;

  ts.forEachChild(sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) foundType = checker.getDeclaredTypeOfSymbol(symbol);
    } else if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      foundType = checker.getTypeFromTypeNode(node.type);
      foundTypeNode = node.type;
    }
  });

  if (!foundType) throw new Error(`Type ${typeName} not found in code`);
  return { type: foundType, checker, typeNode: foundTypeNode };
}

export function normalizeSchema<T extends Record<string, unknown>>(
  schema: T,
): T {
  const clone: any = JSON.parse(JSON.stringify(schema));
  // Strip top-level $schema noise
  delete clone.$schema;
  // Canonicalize recursively
  return deepCanonicalize(clone) as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function sortObjectKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return sorted;
}

function normalizeOneOf(node: any): any {
  if (!Array.isArray(node.oneOf)) return node;
  // If oneOf contains exactly one null and one non-null, put null first.
  if (node.oneOf.length === 2) {
    const a = node.oneOf[0];
    const b = node.oneOf[1];
    const isNull = (x: any) => isPlainObject(x) && x.type === "null";
    if (isNull(b) && !isNull(a)) {
      node.oneOf = [b, a];
    }
  }
  return node;
}

function deepCanonicalize(node: unknown): unknown {
  if (Array.isArray(node)) {
    // Sort specific arrays we know should be order-insensitive
    return (node as unknown[]).map(deepCanonicalize);
  }
  if (!isPlainObject(node)) return node;

  // Clone and canonicalize children first
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = deepCanonicalize(v);
  }

  // Sort known arrays
  if (Array.isArray(out.required)) {
    out.required = [...(out.required as unknown[])].sort();
  }
  if (Array.isArray(out.enum)) {
    out.enum = [...(out.enum as unknown[])].slice().sort();
  }

  // Sort definitions keys deterministically
  if (isPlainObject(out.definitions)) {
    out.definitions = sortObjectKeys(out.definitions as Record<string, unknown>);
  }

  // Apply oneOf normalization for nullable patterns
  normalizeOneOf(out);

  // Finally sort all object keys to ensure stable ordering in comparisons
  return sortObjectKeys(out);
}
