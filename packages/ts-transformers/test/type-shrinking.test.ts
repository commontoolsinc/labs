import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import {
  type CapabilityParamSummary,
  CrossStageState,
  TransformationContext,
} from "../src/core/mod.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import {
  applyCapabilityDefaultsToTypeNode,
  applyShrinkAndWrap,
  containsAnyOrUnknownTypeNode,
  isCellLikeTypeNode,
  isSqliteTypeNode,
  isStreamTypeNode,
  overlayContractCapabilities,
  preservedWrapperFor,
  printTypeNode,
  wrapTypeNodeWithCapability,
} from "../src/transformers/type-shrinking.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, collect, parseModule } from "./transformed-ast.ts";
import { transformFiles } from "./utils.ts";

//
// Structural inspection of printed type nodes.
//
// `printTypeNode` renders a `ts.TypeNode` to text. Asserting on that text with
// `assertStringIncludes` is weak: it matches on formatting and cannot tell a
// property named `title` apart from the word `title` appearing anywhere. These
// helpers reparse the printed type node and expose its members as real AST
// nodes so tests can assert on property names, optional flags, exact member
// types, and the shape of the root node.
//

/** Reparse a printed type node into a `ts.TypeNode`. */
function parseType(printed: string): ts.TypeNode {
  const decl = collect(
    parseModule(`type __T = ${printed};`),
    ts.isTypeAliasDeclaration,
  )[0];
  if (!decl) throw new Error(`Could not parse type node: ${printed}`);
  return decl.type;
}

interface PropInfo {
  optional: boolean;
  type: string;
}

/**
 * Every property signature reachable under `node`, keyed by name, carrying its
 * optional flag and the printed text of its declared type. Nested literals
 * contribute their own members, so `unused` being absent from the map means it
 * appears nowhere in the shape.
 */
function props(node: ts.Node): Map<string, PropInfo> {
  const sf = node.getSourceFile();
  const out = new Map<string, PropInfo>();
  for (const signature of collect(node, ts.isPropertySignature)) {
    const name = ts.isIdentifier(signature.name)
      ? signature.name.text
      : signature.name.getText(sf);
    out.set(name, {
      optional: !!signature.questionToken,
      type: signature.type ? signature.type.getText(sf) : "",
    });
  }
  return out;
}

/** Reparse the printed shrink result and return its member map. */
function shrunkProps(result: ts.TypeNode, sourceFile: ts.SourceFile): {
  node: ts.TypeNode;
  props: Map<string, PropInfo>;
} {
  const node = parseType(printTypeNode(result, sourceFile));
  return { node, props: props(node) };
}

/** True when `node` contains a reference to the qualified name `left.right`. */
function hasQualifiedRef(node: ts.Node, left: string, right: string): boolean {
  return collect(node, ts.isTypeReferenceNode).some((ref) => {
    const name = ref.typeName;
    return ts.isQualifiedName(name) &&
      ts.isIdentifier(name.left) && name.left.text === left &&
      name.right.text === right;
  });
}

function createProgram(source: string): {
  program: ts.Program;
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
  );

  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? source : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";

  const program = ts.createProgram([fileName], compilerOptions, host);
  return { program, sourceFile, checker: program.getTypeChecker() };
}

function createProgramWithFiles(
  files: Record<string, string>,
  entryFileName = "/test.ts",
): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
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
    getSourceFile: (name, languageVersion) =>
      files[name] !== undefined
        ? ts.createSourceFile(
          name,
          files[name]!,
          languageVersion,
          true,
          name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        )
        : undefined,
    resolveModuleNames: (moduleNames) =>
      moduleNames.map((name) => {
        const directMatch = Object.keys(files).find((fileName) =>
          fileName === `/${name}.d.ts` ||
          fileName.endsWith(`/${name}.d.ts`)
        );
        if (!directMatch) {
          return undefined;
        }
        return {
          resolvedFileName: directMatch,
          extension: ts.Extension.Dts,
          isExternalLibraryImport: false,
        };
      }),
  };

  const program = ts.createProgram([entryFileName], compilerOptions, host);
  const sourceFile = program.getSourceFile(entryFileName);
  if (!sourceFile) {
    throw new Error("Expected source file in program.");
  }

  return { sourceFile, checker: program.getTypeChecker() };
}

function findTypeAlias(
  sourceFile: ts.SourceFile,
  aliasName: string,
): ts.TypeAliasDeclaration {
  let found: ts.TypeAliasDeclaration | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === aliasName
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!found) {
    throw new Error(`Type alias ${aliasName} not found`);
  }

  return found;
}

function createParamSummary(
  summary: Partial<CapabilityParamSummary>,
): CapabilityParamSummary {
  return {
    name: "input",
    capability: "opaque",
    readPaths: [],
    writePaths: [],
    opaquePaths: [],
    passthrough: false,
    wildcard: false,
    identityOnly: false,
    ...summary,
  };
}

describe("overlayContractCapabilities()", () => {
  it("returns a reference to an alias whose type holds no cell as written", () => {
    const { sourceFile, checker } = createProgram(`
      type Profile = { name: string };
      type Event = { x: Profile };
    `);
    const alias = findTypeAlias(sourceFile, "Event");

    const result = overlayContractCapabilities(
      alias.type,
      checker.getTypeAtLocation(alias.type),
      createParamSummary({
        capability: "readonly",
        readPaths: [["x", "name"]],
      }),
      checker,
      ts.factory,
      sourceFile,
    );

    expect(result).toBe(alias.type);
  });

  /**
   * The event schema of the one handler, with `event` for its event type, in
   * a module declaring `declaration`, whose callback is `callback`; and the
   * diagnostics compiling it reports, type-checked first where `typeCheck`
   * is set.
   */
  async function eventSchema(
    declaration: string,
    event: string,
    callback: string,
    typeCheck = true,
  ): Promise<{
    event: Record<string, unknown>;
    reported: { type: string; severity: string }[];
  }> {
    const diagnostics: TransformationDiagnostic[] = [];
    const files = await transformFiles({
      "/main.tsx": `/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";
${declaration}
const h = handler<${event}, { c: Writable<number> }>(${callback});
export default pattern<{ c: Writable<number> }>(({ c }) => ({ h: h({ c }) }));`,
    }, {
      types: COMMONFABRIC_TYPES,
      typeCheck,
      pipelineDiagnostics: diagnostics,
    });
    const [schema] = callSchemas(parseModule(files["/main.tsx"]!), "handler");
    return {
      event: schema!,
      reported: diagnostics.map(({ type, severity }) => ({ type, severity })),
    };
  }

  /** Every `asCell` entry list in `schema`, in reading order. */
  function capabilitiesOf(schema: unknown): unknown[] {
    if (Array.isArray(schema)) return schema.flatMap(capabilitiesOf);
    if (typeof schema !== "object" || schema === null) return [];
    const { asCell, ...rest } = schema as Record<string, unknown>;
    return [
      ...(asCell === undefined ? [] : [asCell]),
      ...Object.values(rest).flatMap(capabilitiesOf),
    ];
  }

  it("reports nothing unread for an event holding arrays of objects nested nine deep", async () => {
    // Compiled with no type check first, as `cf` deploys a pattern unless
    // asked to check it, the checker instantiates the arrays as the reading
    // meets them, each after the one enclosing it, and they nest deeper than
    // a recursion is cut at. An array no alias writes is not counted: only a
    // declaration, or an alias's own tuple or array, recurses without end.

    const keys = ["r", "s", "t", "u", "w", "x", "y", "z", "q"];
    const deep = `${keys.map((key) => `{ ${key}: `).join("")}string${
      " }[]".repeat(keys.length)
    }`;
    const { event, reported } = await eventSchema(
      `type Ev = { c: Writable<number>; d: { r: ${deep} } };`,
      "Ev",
      "(e, { c }) => { c.set(e.c.get()); }",
      false,
    );

    expect(event.type).toBe("object");
    expect(reported).toEqual([]);
  });

  it("overlays the capability the callback earns on a cell a generic event alias holds under arrays of objects nested nine deep", async () => {
    // Compiled with no type check first, the nested arrays are each
    // instantiated after the one enclosing it, but the search for a cell does
    // not count an array no alias writes, so it finds the cell nine arrays
    // in, and the reference expands to overlay it.

    const deep = `${"{ a: ".repeat(9)}Writable<number>${" }[]".repeat(9)}`;
    const { event } = await eventSchema(
      `type Box<T> = { v: T; d: ${deep} };`,
      "Box<string>",
      "(e, { c }) => { c.set(e.v.length); }",
      false,
    );
    let level = (event.properties as Record<string, Record<string, unknown>>)
      .d!;
    for (let depth = 0; depth < 9; depth++) {
      const items = level.items as Record<string, unknown>;
      level = (items.properties as Record<string, Record<string, unknown>>).a!;
    }

    expect(level.asCell).toEqual(["opaque"]);
  });

  describe("an event alias that instantiates itself without end", () => {
    // Each `Nest<T[]>` is a new type, so neither the search for a cell nor
    // the expansion of a reference meets one it has read, and both end where
    // `cutsExpansion()` cuts the recursion. Every cell past the cut is
    // opaque.

    for (
      const [shape, declaration, event] of [
        [
          "an object",
          "type Nest<T> = { v: T; inner?: Nest<T[]> };",
          "Nest<string>",
        ],
        ["a tuple", "type Tup<T> = [T, Tup<T[]>?];", "Tup<string>"],
      ] as const
    ) {
      it(`reports what an event alias of ${shape} holding no cell leaves unread past the cut`, async () => {
        const { event: schema, reported } = await eventSchema(
          declaration,
          event,
          "(e, { c }) => { c.set(e ? 1 : 0); }",
        );

        expect(schema).toBeDefined();
        expect(reported.length).toBeGreaterThan(0);
        for (const diagnostic of reported) {
          expect(diagnostic).toEqual({
            type: "schema-type:unread",
            severity: "warning",
          });
        }
      });
    }

    it("gives a cell the event holds the capability the callback earns, and every other cell, past the cut too, opaque", async () => {
      const { event, reported } = await eventSchema(
        "type Nest<T> = { c: Writable<number>; v: T; children: Nest<T[]>[] };",
        "Nest<string>",
        "(e, { c }) => { c.set(e.c.get()); }",
      );
      const properties = event.properties as Record<
        string,
        Record<string, unknown>
      >;
      const child = (properties.children!.items as Record<string, unknown>)
        .properties as Record<string, Record<string, unknown>>;

      expect(properties.c!.asCell).toEqual(["readonly"]);
      expect(child.c!.asCell).toEqual(["opaque"]);
      expect(
        capabilitiesOf(event).filter((capability) =>
          JSON.stringify(capability) !== '["opaque"]'
        ),
      ).toEqual([["readonly"]]);
      for (const diagnostic of reported) {
        expect(diagnostic).toEqual({
          type: "schema-type:unread",
          severity: "warning",
        });
      }
    });
  });

  describe("an event holding a finite chain of one declaration deeper than the cut", () => {
    // Each level of these chains is a newer instantiation of one declaration,
    // as in a recursion without end, so the overlay's cut takes them for one.
    // Past the cut, every cell is opaque, the capability a cell no use reaches
    // earns, as reading each chain to its end would give it.

    /** `Chain<[1, …]>`, `length` ones long. */
    const chainOf = (length: number) =>
      `Chain<[${Array.from({ length }, () => "1").join(", ")}]>`;
    const chain =
      `type Chain<N extends unknown[]> = N extends [unknown, ...infer R]
  ? { value: string; next: Chain<R> }
  : { c: Writable<number> };`;

    it("gives the cell at the end of a chain twelve long the `opaque` capability", async () => {
      const { event, reported } = await eventSchema(
        chain,
        chainOf(12),
        "(e, { c }) => { c.set(e ? 1 : 0); }",
      );

      expect(capabilitiesOf(event)).toEqual([["opaque"]]);
      expect(reported).toEqual([]);
    });

    it("gives the cell at the end of a chain twelve long, read past the cut, the `readonly` capability the callback earns", async () => {
      // A use that reaches past the cut carries the expansion along its path.

      const { event } = await eventSchema(
        chain,
        chainOf(12),
        `(e, { c }) => { c.set(e${".next".repeat(12)}.c.get()); }`,
      );

      expect(capabilitiesOf(event)).toEqual([["readonly"]]);
    });

    it("defines every type a recursive cell value past the cut refers to", async () => {
      // Past the cut, `Inner` is read with its cells opaque, and the value of
      // its `self` cell as written. Each reading refers to the definition of
      // its own, so its recursion refers to one the schema holds.

      const { event } = await eventSchema(
        `interface Inner { c: Writable<number>; self: Writable<Inner> }
type Chain<N extends unknown[]> = N extends [unknown, ...infer R]
  ? { next: Chain<R> }
  : { inner: Inner };`,
        chainOf(12),
        "(e, { c }) => { c.set(e ? 1 : 0); }",
      );
      const referenced = [
        ...JSON.stringify(event).matchAll(/"#\/\$defs\/([^"]+)"/g),
      ].map(([, name]) => name);

      expect(new Set(referenced)).toEqual(new Set(["Inner:opaque", "Inner"]));
      expect(Object.keys(event.$defs as object).sort()).toEqual(
        ["Inner", "Inner:opaque"],
      );
    });

    for (const deepFirst of [true, false]) {
      it(
        `gives \`opaque\` to the cells of a deep and a shallow chain, ${
          deepFirst ? "the deep one" : "the shallow one"
        } declared first`,
        async () => {
          // Cutting the deep chain leaves its search incomplete, which no
          // reading of the shallow chain may take for a search that found no
          // cell.

          const members = [`deep: ${chainOf(12)};`, `shallow: ${chainOf(5)};`];
          const { event } = await eventSchema(
            `${chain}
type Ev<T> = { v: T; ${
              (deepFirst ? members : [...members].reverse()).join(" ")
            } };`,
            "Ev<string>",
            "(e, { c }) => { c.set(e.v.length); }",
          );

          expect(capabilitiesOf(event)).toEqual([["opaque"], ["opaque"]]);
        },
      );
    }

    it("gives a cell read through a short chain `readonly`, and the cell at the end of a chain that grows to it past the cut `opaque`", async () => {
      const { event } = await eventSchema(
        `type Step<N extends unknown[]> = N["length"] extends 9
  ? { c: Writable<number> }
  : { deep: Step<[...N, 1]> };
type Ev<T> = { near: Step<[1, 1, 1, 1, 1, 1, 1]>; far: Step<[]>; v: T };`,
        "Ev<string>",
        "(e, { c }) => { c.set(e.near.deep.deep.c.get()); }",
      );

      expect(capabilitiesOf(event)).toEqual([["readonly"], ["opaque"]]);
    });
  });

  describe("a reference to a generic declaration", () => {
    // The reference's type is the declaration instantiated with the
    // reference's arguments, and the overlay reads that type, not the nodes
    // the declaration writes in its own type parameters.

    it("reads a member written as the alias's type parameter as the argument the reference gives", async () => {
      const { event, reported } = await eventSchema(
        "type Box<T> = { c: Writable<number>; v: T };",
        "Box<string>",
        "(e, { c }) => { c.set(e.c.get()); }",
      );

      expect(event).toEqual({
        type: "object",
        properties: {
          c: { type: "number", asCell: ["readonly"] },
          v: { type: "string" },
        },
        required: ["c", "v"],
      });
      expect(reported).toEqual([]);
    });

    it("overlays the capability the callback earns on a cell the reference gives as an argument", async () => {
      const { event, reported } = await eventSchema(
        "type Pair<T> = { v: T };",
        "Pair<Writable<number>>",
        "(e, { c }) => { c.set(e.v.get()); }",
      );

      expect(event).toEqual({
        type: "object",
        properties: { v: { type: "number", asCell: ["readonly"] } },
        required: ["v"],
      });
      expect(reported).toEqual([]);
    });

    for (
      const [shape, declaration, event, written] of [
        [
          "a generic interface",
          "interface Box<T> { c: Writable<number>; v: T }",
          "Box<string>",
          "interface Box { c: Writable<number>; v: string }",
        ],
        [
          "an interface extending a generic one",
          `interface Base<T> { v: T }
interface Box extends Base<string> { c: Writable<number> }`,
          "Box",
          "interface Box { c: Writable<number>; v: string }",
        ],
        [
          "a cell written around the type parameter",
          "type Box<T> = { c: Writable<T>; v: T[] };",
          "Box<number>",
          "type Box = { c: Writable<number>; v: number[] };",
        ],
        [
          "an optional member",
          "type Box<T> = { c: Writable<number>; v?: T };",
          "Box<string | null>",
          "type Box = { c: Writable<number>; v?: string | null };",
        ],
        [
          "a generic alias the member instantiates in turn",
          `type Inner<U> = { w: Writable<U> };
type Box<T> = { c: Writable<number>; i: Inner<T> };`,
          "Box<string>",
          "type Box = { c: Writable<number>; i: { w: Writable<string> } };",
        ],
        [
          "a mapped type",
          "type Box<T> = { [K in keyof T]: Writable<T[K]> };",
          "Box<{ c: number; v: string }>",
          "type Box = { c: Writable<number>; v: Writable<string> };",
        ],
        [
          "a mapped type that makes members optional",
          "type Ev = { c: Writable<number>; v: string };",
          "Partial<Ev>",
          "type Box = { c?: Writable<number>; v?: string };",
        ],
        [
          "an index signature",
          "type Box<T> = { c: Writable<number>; [key: string]: T | Writable<number> };",
          "Box<string>",
          "type Box = { c: Writable<number>; [key: string]: string | Writable<number> };",
        ],
        [
          "an alias of a cell",
          `type Ref<T> = Writable<T>;
type Box = { c: Writable<number>; r: Ref<string> };`,
          "Box",
          "type Box = { c: Writable<number>; r: Writable<string> };",
        ],
        [
          "an alias of an array",
          `type List<T> = T[];
type Box = { c: Writable<number>; l: List<Writable<string>> };`,
          "Box",
          "type Box = { c: Writable<number>; l: Writable<string>[] };",
        ],
      ] as const
    ) {
      it(`gives ${shape} the event schema of the same type written out`, async () => {
        const callback = event === "Partial<Ev>"
          ? "(e, { c }) => { c.set(e.c?.get() ?? 0); }"
          : "(e, { c }) => { c.set(e.c.get()); }";
        const generic = await eventSchema(declaration, event, callback);
        const plain = await eventSchema(written, "Box", callback);

        expect(capabilitiesOf(plain.event)).toContainEqual(["readonly"]);
        expect(generic.event).toEqual(plain.event);
        expect(generic.reported).toEqual(plain.reported);
      });
    }

    for (
      const [shape, argument, written] of [
        ["an object", "{ name: string }", "{ name: string }"],
        ["an array", "string[]", "string[]"],
      ] as const
    ) {
      it(`marks ${shape} the reference gives as an argument \`comparable\` where the callback only compares its identity, as written out`, async () => {
        const callback = "(e, { c }) => { c.set(equals(e.v, e.v) ? 1 : 0); }";
        const generic = await eventSchema(
          `import { equals } from "commonfabric";
type Box<T> = { c: Writable<number>; v: T };`,
          `Box<${argument}>`,
          callback,
        );
        const plain = await eventSchema(
          `import { equals } from "commonfabric";
type Box = { c: Writable<number>; v: ${written} };`,
          "Box",
          callback,
        );
        const v = (schema: Record<string, unknown>) =>
          (schema.properties as Record<string, Record<string, unknown>>).v!;

        expect(v(plain.event).asCell).toEqual(["comparable"]);
        expect(generic.event).toEqual(plain.event);
      });
    }

    it("reads an optional member whose generic alias denotes a union of several members without the `undefined` its `?` adds", async () => {
      const callback = "(e, { c }) => { c.set(e.c.get()); }";
      const generic = await eventSchema(
        `type Identity<T> = T;
type Box = { c: Writable<number>; v?: Identity<Writable<number> | string> };`,
        "Box",
        callback,
      );
      const plain = await eventSchema(
        "type Box = { c: Writable<number>; v?: Writable<number> | string };",
        "Box",
        callback,
      );
      const alternatives = (schema: Record<string, unknown>) =>
        (schema.properties as Record<string, Record<string, unknown>>).v!
          .anyOf as unknown[];

      expect(alternatives(generic.event)).toHaveLength(2);
      expect(alternatives(generic.event)).toEqual(
        expect.arrayContaining(alternatives(plain.event)),
      );
    });

    it("reads a reference to a generic union alias as the union, overlaying the cell in a member", async () => {
      const { event } = await eventSchema(
        "type Maybe<T> = T | undefined;",
        "Maybe<{ c: Writable<number> }>",
        "(e, { c }) => { c.set(e?.c.get() ?? 0); }",
      );

      expect(event.anyOf).toHaveLength(2);
      expect(event.anyOf).toEqual(expect.arrayContaining([
        { type: "undefined" },
        {
          type: "object",
          properties: { c: { type: "number", asCell: ["readonly"] } },
          required: ["c"],
        },
      ]));
    });

    it("keeps a reference to a generic tuple alias as written, as a tuple written out is", async () => {
      const generic = await eventSchema(
        "type Tup<T> = [Writable<number>, T];",
        "Tup<string>",
        "(e, { c }) => { c.set(e[0].get()); }",
      );
      const plain = await eventSchema(
        "type Tup = [Writable<number>, string];",
        "Tup",
        "(e, { c }) => { c.set(e[0].get()); }",
      );
      const items = (schema: Record<string, unknown>) =>
        (schema.items as Record<string, unknown>).anyOf;

      expect(generic.event.type).toBe("array");
      expect(items(generic.event)).toHaveLength(2);
      expect(items(generic.event)).toEqual(
        expect.arrayContaining(items(plain.event) as unknown[]),
      );
    });
  });

  describe("a scoped cell", () => {
    // Only the scope wrapper names the scope, so the overlay does not rebuild
    // the cell inside it, and the cell keeps the capability written for it.

    for (
      const [spelling, declaration, event] of [
        [
          "written out",
          "type Ev = { c: Writable<number>; s: PerUser<Writable<number>> };",
          "Ev",
        ],
        [
          "given as a generic alias's argument",
          "type Box<T> = { c: Writable<number>; s: T };",
          "Box<PerUser<Writable<number>>>",
        ],
      ] as const
    ) {
      it(`keeps a scoped cell ${spelling} as written, with its scope`, async () => {
        const { event: schema } = await eventSchema(
          `import type { PerUser } from "commonfabric";\n${declaration}`,
          event,
          "(e, { c }) => { c.set(e.c.get()); }",
        );

        expect(schema.properties).toEqual({
          c: { type: "number", asCell: ["readonly"] },
          s: { type: "number", asCell: [{ kind: "cell", scope: "user" }] },
        });
      });
    }
  });

  it("reads an optional member at its type without the `undefined` its `?` adds", async () => {
    const callback = "(e, { c }) => { c.set(e.c.get()); }";
    const { event } = await eventSchema(
      `interface Reply { message: Writable<number>; shownIn: string }
interface Ev { c: Writable<number>; r?: Reply }`,
      "Ev",
      callback,
    );
    const written = await eventSchema(
      `type Ev = {
  c: Writable<number>;
  r?: { message: Writable<number>; shownIn: string };
};`,
      "Ev",
      callback,
    );

    expect((event.properties as Record<string, unknown>).r).toEqual({
      type: "object",
      properties: {
        message: { type: "number", asCell: ["opaque"] },
        shownIn: { type: "string" },
      },
      required: ["message", "shownIn"],
    });
    expect(event).toEqual(written.event);
  });

  describe("a cell the callback uses in a way its summary does not record", () => {
    // A use the capability analysis does not follow member by member gives no
    // capability narrower than the one written to show sufficient, so a cell
    // it reaches keeps the one written, and a cell it does not reach still
    // earns its own.

    const cell = (asCell: string) => ({ type: "number", asCell: [asCell] });
    for (
      const [use, declaration, event, callback, expected] of [
        [
          "a rest element of an object destructuring",
          `import type { ReadonlyCell } from "commonfabric";
type Ev = { a: Writable<number>; b: ReadonlyCell<number> };`,
          "Ev",
          "(e, { c }) => { const { ...rest } = e; c.set(rest.a.get()); }",
          {
            type: "object",
            properties: { a: cell("cell"), b: cell("readonly") },
            required: ["a", "b"],
          },
        ],
        [
          "an array destructuring",
          "type Ev = Writable<number>[];",
          "Ev",
          "(e, { c }) => { const [, b] = e; c.set(b!.get()); }",
          { type: "array", items: cell("cell") },
        ],
        [
          "an array destructuring of the parameter",
          "type Ev = Writable<number>[];",
          "Ev",
          "([a], { c }) => { c.set(a!.get()); }",
          { type: "array", items: cell("cell") },
        ],
        [
          "a key that can name any element",
          "type Ev = { list: { v: Writable<number> }[]; other: Writable<number> };",
          "Ev",
          "(e, { c }) => { c.set(e.list[c.get()]!.v.get()); }",
          {
            type: "object",
            properties: {
              list: {
                type: "array",
                items: {
                  type: "object",
                  properties: { v: cell("cell") },
                  required: ["v"],
                },
              },
              other: cell("opaque"),
            },
            required: ["list", "other"],
          },
        ],
        [
          "a helper with no summary, handed the cell",
          `declare function keep(value: unknown): boolean;
type Ev = { x: Writable<number>; other: Writable<number> };`,
          "Ev",
          "(e, { c }) => { if (keep(e.x)) c.set(1); }",
          {
            type: "object",
            properties: { x: cell("cell"), other: cell("opaque") },
            required: ["x", "other"],
          },
        ],
        [
          "a key that can name any element, in a helper",
          `function pick(list: readonly { v: Writable<number> }[], i: number): number {
  return list[i]!.v.get();
}
type Ev = { list: { v: Writable<number> }[]; other: Writable<number> };`,
          "Ev",
          "(e, { c }) => { c.set(pick(e.list, c.get())); }",
          {
            type: "object",
            properties: {
              list: {
                type: "array",
                items: {
                  type: "object",
                  properties: { v: cell("cell") },
                  required: ["v"],
                },
              },
              other: cell("opaque"),
            },
            required: ["list", "other"],
          },
        ],
        [
          "a traversal of the cell's value alone",
          "type Ev = { x: Writable<number>; other: Writable<number> };",
          "Ev",
          "(e, { c }) => { c.set(JSON.stringify(e.x.get()).length); }",
          {
            type: "object",
            properties: { x: cell("readonly"), other: cell("opaque") },
            required: ["x", "other"],
          },
        ],
      ] as const
    ) {
      it(`gives each cell what ${use} lets the callback do`, async () => {
        const { event: schema, reported } = await eventSchema(
          declaration,
          event,
          callback,
        );

        expect(schema).toEqual(expected);
        expect(reported).toEqual([]);
      });
    }

    describe("past the cut of a recursion", () => {
      // The untracked use reaches cells past the depth where the overlay cuts
      // a recursion and reads its remainder opaque; they keep the capability
      // written for them all the same, and the untouched sibling does not.

      const chain = (length: number) =>
        `type Chain<N extends unknown[]> = N extends [unknown, ...infer R]
  ? { next: Chain<R> }
  : { v: Writable<number> };
type Deep = Chain<[${Array.from({ length }, () => "1").join(", ")}]>;`;
      const nexts = (length: number) => ".next".repeat(length);
      for (
        const [use, declaration, callback] of [
          [
            "a key that can name any element, twelve levels above the cell",
            `${chain(12)}
type Ev = { list: Deep[]; other: Writable<number> };`,
            `(e, { c }) => { c.set(e.list[c.get()]!${nexts(12)}.v.get()); }`,
          ],
          [
            "a helper with no summary, handed a value twelve levels above the cell",
            `declare function keep(value: unknown): number;
${chain(12)}
type Ev = { x: Deep; other: Writable<number> };`,
            "(e, { c }) => { c.set(keep(e.x)); }",
          ],
          [
            "a helper with no summary, handed a value four levels above the cell",
            `declare function keep(value: unknown): number;
${chain(4)}
type Ev = { x: Deep; other: Writable<number> };`,
            "(e, { c }) => { c.set(keep(e.x)); }",
          ],
          [
            "a rest element twelve levels down",
            `${chain(13)}
type Ev = { x: Deep; other: Writable<number> };`,
            `(e, { c }) => { const { ...rest } = e.x${
              nexts(12)
            }; c.set(rest.next.v.get()); }`,
          ],
        ] as const
      ) {
        it(`keeps the cell ${use} reaches as written`, async () => {
          const { event: schema, reported } = await eventSchema(
            declaration,
            "Ev",
            callback,
          );

          expect((schema.properties as Record<string, unknown>).other).toEqual(
            cell("opaque"),
          );
          expect(
            capabilitiesOf(schema).map((capability) =>
              JSON.stringify(capability)
            ).sort(),
          ).toEqual(['["cell"]', '["opaque"]']);
          expect(reported).toEqual([]);
        });
      }
    });

    it("keeps a cell beside one handed on under the empty key opaque", async () => {
      const { event: schema } = await eventSchema(
        `declare function keep(value: unknown): boolean;
type Ev = { "": Writable<number>; other: Writable<number> };`,
        "Ev",
        '(e, { c }) => { if (keep(e[""])) c.set(1); }',
      );

      expect((schema.properties as Record<string, unknown>).other).toEqual(
        cell("opaque"),
      );
    });
  });
});

describe("applyShrinkAndWrap()", () => {
  describe("a member named by the empty string", () => {
    // A path through the member `""` narrows the shape and the cell it reaches
    // as a path through any other name does, and is held to the type as any
    // other path is.

    /**
     * The input schema of the one `lift()` in a module holding `source`, and
     * the types of the diagnostics compiling it reports.
     */
    async function liftInput(
      source: string,
    ): Promise<{ schema: unknown; reported: string[] }> {
      const diagnostics: TransformationDiagnostic[] = [];
      const files = await transformFiles({
        "/main.tsx": `/// <cts-enable />
import { Default, equals, lift, pattern, Writable } from "commonfabric";
${source}
export default pattern<{ v: any }>(({ v }) => ({ m: l(v) }));`,
      }, { types: COMMONFABRIC_TYPES, pipelineDiagnostics: diagnostics });
      return {
        schema: callSchemas(parseModule(files["/main.tsx"]!), "lift")[0],
        reported: diagnostics.map(({ type }) => type),
      };
    }

    const onlyEmpty = (value: Record<string, unknown>) => ({
      type: "object",
      properties: { "": value },
      required: [""],
    });
    for (
      const [shape, source, expected] of [
        [
          "an object",
          'const l = lift((r: { "": string; other: number }) => r[""].length);',
          onlyEmpty({ type: "string" }),
        ],
        [
          "a nested object",
          'const l = lift((r: { inner: { "": string; other: number } }) => r.inner[""].length);',
          {
            type: "object",
            properties: { inner: onlyEmpty({ type: "string" }) },
            required: ["inner"],
          },
        ],
        [
          "an array's element",
          'const l = lift((r: { "": string; other: number }[]) => r[0]![""].length);',
          { type: "array", items: onlyEmpty({ type: "string" }) },
        ],
        [
          "an object, keeping its default",
          'const l = lift((r: { "": Default<string, "x">; other: number }) => r[""].length);',
          onlyEmpty({ type: "string", default: "x" }),
        ],
      ] as const
    ) {
      it(`keeps only the member a read through it names in ${shape}`, async () => {
        const { schema, reported } = await liftInput(source);

        expect(schema).toEqual(expected);
        expect(reported).toEqual([]);
      });
    }

    it("gives the cell under it the capability its read earns", async () => {
      const { schema } = await liftInput(
        'const l = lift((r: { "": Writable<number>; other: Writable<number> }) => r[""].get());',
      );

      expect(schema).toEqual(
        onlyEmpty({ type: "number", asCell: ["readonly"] }),
      );
    });

    it("gives the cell under it the comparable capability where it is only compared", async () => {
      const { schema } = await liftInput(
        'const l = lift((r: { "": Writable<number>; other: Writable<number> }) => equals(r[""], r[""]));',
      );

      expect(schema).toEqual(
        onlyEmpty({ type: "unknown", asCell: ["comparable"] }),
      );
    });

    for (
      const [shape, parameter] of [
        ["an object", "{ other: number }"],
        ["an array", "number[]"],
      ] as const
    ) {
      it(`reports a read through it that ${shape} does not hold`, async () => {
        const { reported } = await liftInput(
          `const l = lift((r: ${parameter}) => (r as any)[""].length);`,
        );

        expect(reported).toContain("schema:path-not-in-type");
      });
    }
  });

  it("records a node printed for a value read whole as printed from its type", () => {
    // A synthetic base node sends the shrink to the value's type, and a value
    // read whole is that type's print.

    const { program, sourceFile, checker } = createProgram(`
      type Item = { title: string; extra: any };
    `);
    const type = checker.getTypeAtLocation(
      findTypeAlias(sourceFile, "Item").type,
    );
    const state = new CrossStageState();
    const context = new TransformationContext({
      program,
      sourceFile,
      tsContext: { factory: ts.factory } as ts.TransformationContext,
      options: { state },
    });

    const result = applyShrinkAndWrap(
      createParamSummary({ readPaths: [[]] }),
      ts.factory.createTypeReferenceNode("Item"),
      type,
      false,
      checker,
      sourceFile,
      ts.factory,
      "full",
      "opaque",
      context,
    );

    expect(state.printedFrom(result)).toBe(type);
  });
});

Deno.test("applyShrinkAndWrap preserves tuple roots for length-only synthetic shrinking", () => {
  const { sourceFile, checker } = createProgram(`
    type Pair = [number, string];
  `);
  const alias = findTypeAlias(sourceFile, "Pair");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(printTypeNode(result, sourceFile), "Pair");
});

Deno.test("applyShrinkAndWrap does not treat numeric index signatures as arrays", () => {
  const { sourceFile, checker } = createProgram(`
    type Indexed = { [index: number]: string };
  `);
  const alias = findTypeAlias(sourceFile, "Indexed");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(printTypeNode(result, sourceFile), "unknown");
});

Deno.test("applyShrinkAndWrap treats numeric index plus length as array-like", () => {
  const { sourceFile, checker } = createProgram(`
    type Option = {
      id: string;
      title: string;
      addedByName: string;
    };
    type Input = {
      length: number;
      [index: number]: Option;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"], ["0", "title"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    `{
    title: string;
}[]`,
  );
});

Deno.test("applyShrinkAndWrap preserves full array item shapes for direct array reads", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = {
      people: {
        active: boolean;
        name: string;
        priorityRank: number;
      }[];
      other: string;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["people"], ["people", "0", "active"]],
      fullShapePaths: [["people"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assert(members.has("people"));
  assertEquals(members.get("active")?.type, "boolean");
  assertEquals(members.get("name")?.type, "string");
  assertEquals(members.get("priorityRank")?.type, "number");
  assertEquals(members.has("other"), false);
});

Deno.test("applyShrinkAndWrap keeps numeric array access array-shaped", () => {
  const { sourceFile, checker } = createProgram(`
    type Option = {
      id: string;
      title: string;
      addedByName: string;
    };
    type Input = Option[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"], ["0", "title"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    `{
    title: string;
}[]`,
  );
});

Deno.test("applyShrinkAndWrap prefers array-shaped semantic shrink over synthetic numeric object", () => {
  const { sourceFile, checker } = createProgram(`
    type Option = {
      id: string;
      title: string;
      addedByName: string;
    };
    type Input = Option[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createTypeLiteralNode([
    ts.factory.createPropertySignature(
      undefined,
      ts.factory.createNumericLiteral("0"),
      undefined,
      ts.factory.createTypeLiteralNode([
        ts.factory.createPropertySignature(
          undefined,
          "title",
          undefined,
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ),
      ]),
    ),
    ts.factory.createPropertySignature(
      undefined,
      "length",
      undefined,
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
    ),
  ]);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"], ["0", "title"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    `{
    title: string;
}[]`,
  );
});

Deno.test("applyShrinkAndWrap materializes item paths for synthetic unknown arrays", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = unknown[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createTypeLiteralNode([
    ts.factory.createPropertySignature(
      undefined,
      ts.factory.createNumericLiteral("0"),
      undefined,
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    ),
    ts.factory.createPropertySignature(
      undefined,
      "length",
      undefined,
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
    ),
  ]);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"], ["0", "title"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    `{
    title: unknown;
}[]`,
  );
});

Deno.test("applyShrinkAndWrap defaults-only fallback expands repeated child leaves independently", () => {
  const { sourceFile, checker } = createProgram(`
    type Shared = { a: string; b: string };
    type Input = { group: { left: Shared; right: Shared } };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const baseTypeNode = ts.factory.createTypeReferenceNode("Input");

  const result = applyShrinkAndWrap(
    createParamSummary({
      defaults: [{
        path: ["group", "left", "a"],
        defaultType: ts.factory.createKeywordTypeNode(
          ts.SyntaxKind.StringKeyword,
        ),
      }],
    }),
    baseTypeNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
    "defaults_only",
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  // Both `left` and `right` are expanded into inline literals with `a` and `b`
  // leaves rather than left as `Shared` references.
  assertEquals(members.get("a")?.type, "string");
  assertEquals(members.get("b")?.type, "string");
  const right = collect(node, ts.isPropertySignature).find((signature) =>
    ts.isIdentifier(signature.name) && signature.name.text === "right"
  );
  assert(right && right.type && ts.isTypeLiteralNode(right.type));
});

Deno.test("applyShrinkAndWrap preserves nested primitive leaves for property-only access", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = { text: string };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const baseTypeNode = ts.factory.createTypeReferenceNode("Input");

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["text", "length"]],
    }),
    baseTypeNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("text")?.type, "string");
  assertEquals(members.has("length"), false);
});

Deno.test("applyShrinkAndWrap turns identity-only wrapped inputs into OpaqueCell<unknown>", () => {
  const { sourceFile, checker } = createProgram(`
    type Item = { name: string; nested: { value: number } };
  `);
  const alias = findTypeAlias(sourceFile, "Item");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityOnly: true,
      passthrough: true,
    }),
    ts.factory.createTypeReferenceNode("Input"),
    baseType,
    true,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    "__cfHelpers.OpaqueCell<unknown>",
  );
});

Deno.test("applyShrinkAndWrap turns comparable wrapped inputs into ComparableCell<unknown>", () => {
  const { sourceFile, checker } = createProgram(`
    type Item = { name: string; nested: { value: number } };
  `);
  const alias = findTypeAlias(sourceFile, "Item");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      capability: "comparable",
      identityOnly: true,
      passthrough: true,
    }),
    ts.factory.createTypeReferenceNode("Input"),
    baseType,
    true,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    "__cfHelpers.ComparableCell<unknown>",
  );
});

Deno.test("applyShrinkAndWrap turns identity-only unwrapped inputs into unknown", () => {
  const { sourceFile, checker } = createProgram(`
    type Item = { name: string; nested: { value: number } };
  `);
  const alias = findTypeAlias(sourceFile, "Item");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityOnly: true,
      passthrough: true,
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(printTypeNode(result, sourceFile), "unknown");
});

Deno.test("applyShrinkAndWrap turns identity-only cell leaves into OpaqueCell<unknown>", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type Writable<T> = { readonly value?: T };
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    type Input = {
      left: __cfHelpers.Writable<{ name: string; nested: { value: number } }>;
      right: __cfHelpers.Writable<{ name: string; nested: { value: number } }>;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["left"], ["right"]],
      identityCellPaths: [["left"], ["right"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("left")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.get("right")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.has("name"), false);
  assertEquals(members.has("nested"), false);
});

Deno.test("applyShrinkAndWrap turns read-only cell leaves into ReadonlyCell", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type Writable<T> = { readonly value?: T };
      export type ReadonlyCell<T> = { readonly readonly?: T };
    }
    type Input = {
      value: __cfHelpers.Writable<number>;
      untouched: __cfHelpers.Writable<string>;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      capability: "readonly",
      readPaths: [["value"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("value")?.type, "__cfHelpers.ReadonlyCell<number>");
  assertEquals(members.has("untouched"), false);
});

Deno.test("applyShrinkAndWrap turns opaque derivation cell leaves into OpaqueCell", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type Writable<T> = { readonly value?: T };
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    type Input = {
      items: __cfHelpers.Writable<{ name: string }[]>;
      untouched: __cfHelpers.Writable<string>;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      opaquePaths: [["items"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  const items = members.get("items");
  assert(items && hasQualifiedRef(node, "__cfHelpers", "OpaqueCell"));
  assert(items.type.startsWith("__cfHelpers.OpaqueCell<"));
  assertEquals(members.get("name")?.type, "string");
  assertEquals(members.has("untouched"), false);
});

Deno.test("applyShrinkAndWrap turns comparable cell leaves into ComparableCell<unknown>", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type Writable<T> = { readonly value?: T };
      export type ComparableCell<T> = { readonly comparable?: T };
    }
    type Input = {
      left: __cfHelpers.Writable<{ name: string; nested: { value: number } }>;
      right: __cfHelpers.Writable<{ name: string; nested: { value: number } }>;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      capability: "comparable",
      identityPaths: [["left"], ["right"]],
      identityCellPaths: [["left"], ["right"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(
    members.get("left")?.type,
    "__cfHelpers.ComparableCell<unknown>",
  );
  assertEquals(
    members.get("right")?.type,
    "__cfHelpers.ComparableCell<unknown>",
  );
  assertEquals(members.has("name"), false);
  assertEquals(members.has("nested"), false);
});

Deno.test("applyShrinkAndWrap lets identity containers cover retained child paths", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = {
      item: { active: boolean; name: string };
      untouched: string;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["item", "active"]],
      identityPaths: [["item"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("item")?.type, "unknown");
  assertEquals(members.has("active"), false);
  assertEquals(members.has("name"), false);
});

Deno.test("applyShrinkAndWrap shrinks direct array parameters to used item fields", () => {
  const { sourceFile, checker } = createProgram(`
    type AssetRecord = {
      id: string;
      stage: string;
      owner: string;
      unused: { nested: string };
    };
    type Input = AssetRecord[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["id"], ["stage"], ["owner"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("id")?.type, "string");
  assertEquals(members.get("stage")?.type, "string");
  assertEquals(members.get("owner")?.type, "string");
  assertEquals(members.has("unused"), false);
  assertEquals(members.has("nested"), false);
});

Deno.test("applyShrinkAndWrap preserves inherited interface fields in array unions", () => {
  const { sourceFile, checker } = createProgram(`
    interface LeadState {
      id: string;
      name: string;
    }

    interface LeadScoreSummary extends LeadState {
      score: number;
      unused: string;
    }

    type Input = LeadScoreSummary[] | undefined;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["0", "id"], ["0", "score"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("id")?.type, "string");
  assertEquals(members.get("score")?.type, "number");
  assertEquals(members.has("name"), false);
  assertEquals(members.has("unused"), false);
});

Deno.test("applyShrinkAndWrap preserves aliased fixed-symbol keys in node-driven shrinking", () => {
  const { sourceFile, checker } = createProgramWithFiles({
    "/test.ts": `
      import { SELF as CF_SELF } from "commonfabric";

      type Input = {
        [CF_SELF]?: { id: string; title: string };
        value: string;
      };
    `,
    "/commonfabric.d.ts": `
      export declare const SELF: unique symbol;
    `,
  });
  const alias = findTypeAlias(sourceFile, "Input");

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["$SELF", "id"]],
    }),
    alias.type,
    undefined,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("[CF_SELF]")?.optional, true);
  assertEquals(members.get("id")?.type, "string");
  assertEquals(members.has("title"), false);
  assertEquals(members.has("value"), false);
});

Deno.test("applyCapabilityDefaultsToTypeNode applies defaults through tuples and unions", () => {
  const { sourceFile, checker } = createProgram(`
    type Input =
      | [{ name?: string; unused?: string }]
      | { fallback?: string; unused?: string };
    type NameDefault = "Anonymous";
    type FallbackDefault = "Fallback";
  `);
  const input = findTypeAlias(sourceFile, "Input");
  const nameDefault = findTypeAlias(sourceFile, "NameDefault");
  const fallbackDefault = findTypeAlias(sourceFile, "FallbackDefault");
  const baseType = checker.getTypeAtLocation(input.type);

  const result = applyCapabilityDefaultsToTypeNode(
    input.type,
    [
      { path: ["0", "name"], defaultType: nameDefault.type },
      { path: ["fallback"], defaultType: fallbackDefault.type },
    ],
    baseType,
    [["0", "name"], ["fallback"]],
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("name")?.optional, true);
  assertEquals(
    members.get("name")?.type,
    '__cfHelpers.Default<string, "Anonymous">',
  );
  assertEquals(members.get("fallback")?.optional, true);
  assertEquals(
    members.get("fallback")?.type,
    '__cfHelpers.Default<string, "Fallback">',
  );
});

Deno.test("type shrinking helper predicates detect wrapper type nodes", () => {
  const { sourceFile, checker } = createProgram(`
    type CellValue = Cell<string>;
    type StreamValue = Stream<string>;
    type SqliteValue = SqliteDb<{ id: string }>;
    type PlainValue = string;
    type AnyUnion = { value: any } | { fallback: unknown };
  `);
  const cellNode = findTypeAlias(sourceFile, "CellValue").type;
  const streamNode = findTypeAlias(sourceFile, "StreamValue").type;
  const sqliteNode = findTypeAlias(sourceFile, "SqliteValue").type;
  const plainNode = findTypeAlias(sourceFile, "PlainValue").type;
  const anyUnionNode = findTypeAlias(sourceFile, "AnyUnion").type;

  assertEquals(containsAnyOrUnknownTypeNode(anyUnionNode), true);
  assertEquals(containsAnyOrUnknownTypeNode(plainNode), false);
  assertEquals(isCellLikeTypeNode(cellNode), true);
  assertEquals(isCellLikeTypeNode(sqliteNode), false);
  assertEquals(isStreamTypeNode(streamNode), true);
  assertEquals(isStreamTypeNode(cellNode), false);
  assertEquals(isSqliteTypeNode(sqliteNode), true);
  assertEquals(isSqliteTypeNode(cellNode), false);
  assertEquals(preservedWrapperFor(streamNode, undefined, checker), "Stream");
  assertEquals(preservedWrapperFor(sqliteNode, undefined, checker), "SqliteDb");
  assertEquals(preservedWrapperFor(plainNode, undefined, checker), undefined);
});

Deno.test("applyShrinkAndWrap descends identity paths through named interface references", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    interface Inner { keep: string; drop: number; }
    interface Outer { inner: Inner; other: string; }
    type Input = Outer;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["inner", "drop"], ["other"]],
      identityPaths: [["inner", "keep"]],
      identityCellPaths: [["inner", "keep"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  // The reference resolves to declared members, recurses into `inner`, and
  // wraps the `keep` leaf. Identity-path application transforms the targeted
  // leaf in place and leaves the members the summary reads intact.
  assertEquals(members.get("keep")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.get("drop")?.type, "number");
  assertEquals(members.get("other")?.type, "string");
});

Deno.test("applyShrinkAndWrap rebuilds inline literals when a nested identity leaf changes", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    type Input = {
      inner: { keep: string; drop: number };
      other: string;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["inner", "drop"], ["other"]],
      identityPaths: [["inner", "keep"]],
      identityCellPaths: [["inner", "keep"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("keep")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.get("drop")?.type, "number");
  assertEquals(members.get("other")?.type, "string");
});

Deno.test("applyShrinkAndWrap returns an inline literal unchanged when a nested identity path does not resolve", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = {
      a: { x: string };
      b: string;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["a", "x"], ["b"]],
      identityPaths: [["a", "missing"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  // No member changes, so the literal (and its `a` member) is returned as-is.
  assertEquals(members.get("x")?.type, "string");
  assertEquals(members.get("b")?.type, "string");
  assertEquals(hasQualifiedRef(node, "__cfHelpers", "OpaqueCell"), false);
});

Deno.test("applyShrinkAndWrap prunes members no path reaches when every path is an identity path", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    type Input = {
      inner: { keep: string; drop: number };
      other: string;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["inner", "keep"]],
      identityCellPaths: [["inner", "keep"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  // Only `inner.keep` is used, and only for its identity: it is narrowed, and
  // the members no path reaches are pruned as any shrink prunes them.
  assertEquals(members.get("keep")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.has("drop"), false);
  assertEquals(members.has("other"), false);
});

Deno.test("applyShrinkAndWrap leaves array elements untouched when an identity item path does not resolve", () => {
  const { sourceFile, checker } = createProgram(`
    interface Item { keep: string; drop: number; }
    type Input = Item[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["0", "missing"]],
      identityCellPaths: [["0", "missing"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const printed = printTypeNode(result, sourceFile);
  // The item path names no real member, so the element type (and the whole
  // array node) is returned unchanged.
  assertEquals(printed, "Item[]");
});

Deno.test("applyShrinkAndWrap descends identity item paths through readonly arrays", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    interface Item { keep: string; drop: number; }
    type Input = readonly Item[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["0", "drop"]],
      identityPaths: [["0", "keep"]],
      identityCellPaths: [["0", "keep"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  // The readonly-array node recurses into its element type, resolves the item
  // interface's members, and wraps the requested leaf in place.
  assert(ts.isTypeOperatorNode(node));
  assertEquals(node.operator, ts.SyntaxKind.ReadonlyKeyword);
  assertEquals(members.get("keep")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.get("drop")?.type, "number");
});

Deno.test("wrapTypeNodeWithCapability emits the expected cell wrappers", () => {
  const { sourceFile } = createProgram(`type Value = string;`);
  const valueNode = findTypeAlias(sourceFile, "Value").type;

  const wrappers = [
    ["readonly", "ReadonlyCell"],
    ["comparable", "ComparableCell"],
    ["writeonly", "WriteonlyCell"],
    ["writable", "Writable"],
    ["opaque", "OpaqueCell"],
  ] as const;

  for (const [capability, wrapperName] of wrappers) {
    const node = parseType(printTypeNode(
      wrapTypeNodeWithCapability(valueNode, capability, ts.factory),
      sourceFile,
    ));
    assert(ts.isTypeReferenceNode(node));
    assert(hasQualifiedRef(node, "__cfHelpers", wrapperName));
    assert(node.typeArguments && node.typeArguments.length === 1);
    assertEquals(
      node.typeArguments[0]!.getText(node.getSourceFile()),
      "string",
    );
  }
});

Deno.test("applyShrinkAndWrap preserves a parenthesized capture while narrowing cell capability", () => {
  const { sourceFile, checker } = createProgramWithFiles({
    "/commonfabric.d.ts": "export interface Cell<T> { get(): T; }",
    "/test.ts": `
      import type { Cell } from "commonfabric";
      type Input = ({ value: Cell<{ count: number }>; other: string });
    `,
  });
  const alias = findTypeAlias(sourceFile, "Input");
  const result = applyShrinkAndWrap(
    createParamSummary({ wildcard: true, readPaths: [["value"]] }),
    alias.type,
    checker.getTypeAtLocation(alias.type),
    false,
    checker,
    sourceFile,
    ts.factory,
  );
  const { node } = shrunkProps(result, sourceFile);
  expect(ts.isParenthesizedTypeNode(node)).toBe(true);
  if (!ts.isParenthesizedTypeNode(node) || !ts.isTypeLiteralNode(node.type)) {
    throw new Error("Expected a parenthesized object capture");
  }
  const outer = node.type.members.filter(ts.isPropertySignature);
  expect(
    outer.map((member) =>
      ts.isIdentifier(member.name) ? member.name.text : undefined
    ),
  )
    .toEqual(["value", "other"]);
  const value = outer[0]!;
  const other = outer[1]!;
  expect(other.type?.kind).toBe(ts.SyntaxKind.StringKeyword);
  if (!value.type || !ts.isTypeReferenceNode(value.type)) {
    throw new Error("Expected the value property to carry the Cell wrapper");
  }
  if (
    !ts.isQualifiedName(value.type.typeName) ||
    !ts.isIdentifier(value.type.typeName.left)
  ) {
    throw new Error("Expected a qualified Cell wrapper");
  }
  expect(value.type.typeName.left.text).toBe("__cfHelpers");
  expect(value.type.typeName.right.text).toBe("ReadonlyCell");
  expect(value.type.typeArguments).toHaveLength(1);
  const payload = value.type.typeArguments![0]!;
  if (!ts.isTypeLiteralNode(payload)) {
    throw new Error("Expected a Cell payload object");
  }
  expect(payload.members).toHaveLength(1);
  const count = payload.members[0]!;
  if (!ts.isPropertySignature(count) || !ts.isIdentifier(count.name)) {
    throw new Error("Expected the Cell payload's count property");
  }
  expect(count.name.text).toBe("count");
  expect(count.type?.kind).toBe(ts.SyntaxKind.NumberKeyword);
});
