import ts from "typescript";
import { assert, assertEquals } from "@std/assert";
import { analyzeFunctionCapabilities } from "../../src/policy/mod.ts";

// These cases drive `analyzeFunctionCapabilities` through three branches that
// otherwise run only when a pattern happens to compile cold through the
// transformer in CI. With a warm compile cache that compilation is skipped, so
// the branches flip between covered and uncovered across identical CI runs. Each
// test constructs the smallest callback body that reaches its branch and pins
// the observable parameter summary the branch produces.

function createProgram(
  source: string,
): { program: ts.Program; sourceFile: ts.SourceFile } {
  const files: Record<string, string> = { "/test.ts": source };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
  };
  const host: ts.CompilerHost = {
    fileExists: (name) => files[name] !== undefined,
    readFile: (name) => files[name],
    directoryExists: () => true,
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
    getSourceFile: (name, lv) =>
      files[name] !== undefined
        ? ts.createSourceFile(name, files[name]!, lv, true, ts.ScriptKind.TS)
        : undefined,
  };
  const program = ts.createProgram(["/test.ts"], options, host);
  return { program, sourceFile: program.getSourceFile("/test.ts")! };
}

function findArrow(
  sourceFile: ts.SourceFile,
  variableName: string,
): ts.ArrowFunction {
  let cb: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (cb) return;
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === variableName && node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      cb = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!cb) throw new Error(`Expected arrow function '${variableName}'.`);
  return cb;
}

function analyze(source: string, name = "fn") {
  const { program, sourceFile } = createProgram(source);
  return analyzeFunctionCapabilities(findArrow(sourceFile, name), {
    checker: program.getTypeChecker(),
  });
}

// Analyze without a type checker (identity-argument callees are then recognized
// by name, and computed element access widens to a dynamic source).
function analyzeNoChecker(source: string, name = "fn") {
  const { sourceFile } = createProgram(source);
  return analyzeFunctionCapabilities(findArrow(sourceFile, name));
}

function getPaths(
  summary: ReturnType<typeof analyzeFunctionCapabilities>,
  name: string,
) {
  const p = summary.params.find((entry) => entry.name === name);
  if (!p) throw new Error(`Missing parameter summary for '${name}'.`);
  return {
    capability: p.capability,
    readPaths: p.readPaths.map((x) => x.join(".")),
    writePaths: p.writePaths.map((x) => x.join(".")),
    wildcard: p.wildcard,
    passthrough: p.passthrough,
    identityPaths: (p.identityPaths ?? []).map((x) => x.join(".")),
  };
}

const CELL = `declare const CELL_BRAND: unique symbol;
type Cell<T> = {
  readonly [CELL_BRAND]: "cell";
  get(): T;
  set(value: T): void;
  push(...items: unknown[]): number;
};`;

// Branch: the fallthrough `trackReadRef(resolvedSource, { identityOnly: true })`
// (capability-analysis.ts ~2833-2837). Reached when an alias used as the
// argument of a known identity call is itself a dynamic source: the three
// earlier `!dynamic` guards all fall through, and because the ref is dynamic the
// read widens the whole parameter root to wildcard.
Deno.test(
  "identity call on a dynamic alias widens the parameter root to wildcard",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input, k) => {
           const v = input[k];
           navigateTo(v);
         };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, true);
    assertEquals(input.readPaths.length, 0);
    assertEquals(input.writePaths.length, 0);
  },
);

Deno.test(
  "equals() on a dynamic alias also widens the parameter root to wildcard",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input, k, other) => {
           const v = input[k];
           v.equals(other);
         };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

// Branch: `updateLocalCollectionBinding` deletes the tracked map-value binding
// when two `.set()` calls store non-equal sources so their merge is undefined
// (capability-analysis.ts ~1977-1979). Contrast with a single `.set()`, where
// the binding survives and a later `.get(k).name` resolves through it.
Deno.test(
  "a single map .set() lets a later .get().member resolve through the value binding",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
           const m = new Map();
           m.set("k", input.a);
           const v = m.get("k");
           return v.name;
         };`,
      ),
      "input",
    );
    // The stored binding survives, so the member read resolves to input.a.name.
    assert(input.readPaths.includes("a.name"));
  },
);

Deno.test(
  "conflicting map .set() values drop the value binding so .get().member no longer resolves",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
           const m = new Map();
           m.set("k", input.a);
           m.set("k", input.b);
           const v = m.get("k");
           return v.name;
         };`,
      ),
      "input",
    );
    // Both set arguments are still read at set time.
    assert(input.readPaths.includes("a"));
    assert(input.readPaths.includes("b"));
    // But the merged binding was deleted, so the later `.get("k").name` resolves
    // to no source: neither a.name nor b.name is recorded.
    assert(!input.readPaths.includes("a.name"));
    assert(!input.readPaths.includes("b.name"));
  },
);

// Branch: an array-identity writer (`push`) whose argument aliases an
// array element reads that element's path (capability-analysis.ts ~3128-3130).
// The `.find()` result carries an array-element binding, so pushing it records a
// read of the element path rather than treating the pushed value as opaque.
Deno.test(
  "push() of an array-element alias reads the element path",
  () => {
    const input = getPaths(
      analyze(
        `${CELL}
         const fn = (
           input: { rows: { id: string }[] },
           list: Cell<unknown[]>,
         ) => {
           const found = input.rows.find((r) => r.id === "x");
           list.push(found);
         };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("rows.0"));
  },
);
