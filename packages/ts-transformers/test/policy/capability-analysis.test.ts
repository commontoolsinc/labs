import ts from "typescript";
import { assert, assertEquals } from "@std/assert";
import { analyzeFunctionCapabilities } from "../../src/policy/mod.ts";

function parseFirstCallback(source: string): ts.ArrowFunction | ts.FunctionExpression {
  const file = ts.createSourceFile(
    "/test.ts",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  let callback: ts.ArrowFunction | ts.FunctionExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (callback) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      callback = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  if (!callback) {
    throw new Error("Expected a callback expression in test source.");
  }

  return callback;
}

function getPaths(summary: ReturnType<typeof analyzeFunctionCapabilities>, name: string): {
  capability: string;
  readPaths: string[];
  writePaths: string[];
  wildcard: boolean;
  passthrough: boolean;
} {
  const param = summary.params.find((entry) => entry.name === name);
  if (!param) {
    throw new Error(`Missing parameter summary for '${name}'.`);
  }
  return {
    capability: param.capability,
    readPaths: param.readPaths.map((path) => path.join(".")),
    writePaths: param.writePaths.map((path) => path.join(".")),
    wildcard: param.wildcard,
    passthrough: param.passthrough,
  };
}

Deno.test("Capability analysis tracks alias assignment chains", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      const alias = input;
      const user = alias.user;
      return user.name;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes("user"));
  assert(input.readPaths.includes("user.name"));
});

Deno.test("Capability analysis tracks object destructure aliases", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      const { foo, bar: b, user: { name } } = input;
      return [foo, b, name].join("-");
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes("foo"));
  assert(input.readPaths.includes("bar"));
  assert(input.readPaths.includes("user.name"));
});

Deno.test("Capability analysis tracks reassignment aliases", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      let current = input;
      current = current.user;
      return current.name;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes("user"));
  assert(input.readPaths.includes("user.name"));
});

Deno.test("Capability analysis treats dynamic alias keys as wildcard", () => {
  const fn = parseFirstCallback(
    `const fn = (input, key) => {
      const alias = input;
      return alias[key];
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.wildcard, true);
});

Deno.test("Capability analysis does not record method names as read paths", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => input.get().foo;`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assert(input.readPaths.includes(""));
  assert(!input.readPaths.includes("get"));
});
