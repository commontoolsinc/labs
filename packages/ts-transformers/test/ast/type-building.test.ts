import { assertEquals, assertStrictEquals } from "@std/assert";
import ts from "typescript";

import { cloneTypeNodeDeepForEmission } from "../../src/ast/type-building.ts";

// The printer extracts literal text by source position from the file it is
// printing. A declaration member's type node reused in ANOTHER file therefore
// emits garbage tokens for literal types (e.g. the `"n/a"` in
// `Default<string, "n/a">` printed as whatever sits at those offsets in the
// emit file). cloneTypeNodeDeepForEmission strips positions throughout so
// literals print from their own `.text`. (Same guarantee as the helper of
// this name on the #4078 branch.)
Deno.test("cloneTypeNodeDeepForEmission prints cross-file literal types from their own text", () => {
  const declarationFile = ts.createSourceFile(
    "declaration.ts",
    `interface I { label: Default<string, "default-text">; }`,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const iface = declarationFile.statements[0] as ts.InterfaceDeclaration;
  const member = iface.members[0] as ts.PropertySignature;
  const typeNode = member.type!;

  // A different, shorter emit file: position-based extraction cannot
  // reproduce the literal from here.
  const emitFile = ts.createSourceFile(
    "emit.ts",
    "export {};",
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const printer = ts.createPrinter({ removeComments: true });

  const cloned = cloneTypeNodeDeepForEmission(typeNode);
  const printed = printer.printNode(ts.EmitHint.Unspecified, cloned, emitFile);

  assertEquals(printed, `Default<string, "default-text">`);
});

Deno.test("cloneTypeNodeDeepForEmission carries typeRegistry entries onto clones", () => {
  const declarationFile = ts.createSourceFile(
    "declaration.ts",
    `interface I { label: Default<string, "x">; }`,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const iface = declarationFile.statements[0] as ts.InterfaceDeclaration;
  const member = iface.members[0] as ts.PropertySignature;
  const typeNode = member.type!;

  const fakeType = { flags: ts.TypeFlags.String } as ts.Type;
  const typeRegistry = new WeakMap<ts.Node, ts.Type>();
  typeRegistry.set(typeNode, fakeType);

  const cloned = cloneTypeNodeDeepForEmission(typeNode, typeRegistry);

  assertStrictEquals(typeRegistry.get(cloned), fakeType);
});
