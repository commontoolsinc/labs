import ts from "typescript";
import { StaticCache } from "@commontools/static";
import { isObject } from "@commontools/utils/types";

// Cache for TypeScript library definitions
let typeLibsCache: Record<string, string> | undefined;

/**
 * Load TypeScript environment types (es2023, dom, jsx)
 * Same functionality as js-runtime but implemented independently
 */
async function getTypeScriptEnvironmentTypes(): Promise<
  Record<string, string>
> {
  if (typeLibsCache) {
    return typeLibsCache;
  }

  const cache = new StaticCache();
  const es2023 = await cache.getText("types/es2023.d.ts");
  const jsx = await cache.getText("types/jsx.d.ts");
  const dom = await cache.getText("types/dom.d.ts");

  typeLibsCache = {
    es2023,
    dom,
    jsx,
  };
  return typeLibsCache;
}

export async function createTestProgram(
  code: string,
): Promise<
  { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile }
> {
  const fileName = "test.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.ES2023,
    true,
  );

  // Load TypeScript library definitions
  const typeLibs = await getTypeScriptEnvironmentTypes();

  const compilerHost: ts.CompilerHost = {
    getSourceFile: (name) => {
      if (name === fileName) {
        return sourceFile;
      }

      // Map lib.d.ts requests to es2023 definitions (same as js-runtime)
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        return ts.createSourceFile(
          name,
          typeLibs.es2023 || "",
          ts.ScriptTarget.ES2023,
          true,
        );
      }

      // Handle other library files (map case-insensitive)
      const libName = name.toLowerCase().replace(".d.ts", "");
      if (typeLibs[libName]) {
        return ts.createSourceFile(
          name,
          typeLibs[libName],
          ts.ScriptTarget.ES2023,
          true,
        );
      }

      return undefined;
    },
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => {
      if (name === fileName) return true;
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) return true;

      // Check library files (case-insensitive)
      const libName = name.toLowerCase().replace(".d.ts", "");
      if (typeLibs[libName]) return true;

      return false;
    },
    readFile: (name) => {
      if (name === fileName) return code;
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        return typeLibs.es2023;
      }

      // Handle library files (case-insensitive)
      const libName = name.toLowerCase().replace(".d.ts", "");
      if (typeLibs[libName]) return typeLibs[libName];

      return undefined;
    },
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
  };

  const program = ts.createProgram([fileName], {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    // Add proper lib configuration (key difference from broken version)
    lib: ["ES2023", "DOM", "JSX"],
    strict: true,
    strictNullChecks: true,
  }, compilerHost);

  return {
    program,
    checker: program.getTypeChecker(),
    sourceFile: sourceFile!,
  };
}

export async function getTypeFromCode(
  code: string,
  typeName: string,
): Promise<{ type: ts.Type; checker: ts.TypeChecker; typeNode?: ts.TypeNode }> {
  const { program, checker, sourceFile } = await createTestProgram(code);

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
  return foundTypeNode
    ? { type: foundType, checker, typeNode: foundTypeNode }
    : { type: foundType, checker };
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

function sortObjectKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return sorted;
}

function normalizeAnyOf(node: any): any {
  if (!Array.isArray(node.anyOf)) return node;
  // If anyOf contains exactly one null and one non-null, put null first.
  if (node.anyOf.length === 2) {
    const a = node.anyOf[0];
    const b = node.anyOf[1];
    const isNull = (x: any) => isObject(x) && (x as any).type === "null";
    if (isNull(b) && !isNull(a)) {
      node.anyOf = [b, a];
    }
  }
  return node;
}

function deepCanonicalize(node: unknown): unknown {
  if (Array.isArray(node)) {
    // Sort specific arrays we know should be order-insensitive
    return (node as unknown[]).map(deepCanonicalize);
  }
  if (!isObject(node)) return node;

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
  if (isObject(out.definitions)) {
    out.definitions = sortObjectKeys(
      out.definitions as Record<string, unknown>,
    );
  }

  // Apply anyOf normalization for nullable patterns
  normalizeAnyOf(out);

  // Finally sort all object keys to ensure stable ordering in comparisons
  return sortObjectKeys(out);
}
