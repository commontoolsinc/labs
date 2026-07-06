import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { parseFunctionText } from "../src/sandbox/compiled-js-parser.ts";
import {
  type BindingInfo,
  classifyModuleItems,
} from "../src/sandbox/compiled-bundle-verifier.ts";

// The security classifier extracted from the AMD verifier is format-agnostic:
// it classifies a module's top-level items (compiled-CJS form) against a
// pre-seeded binding env, independent of AMD/ESM packaging. AMD passes the
// canonical shadow guards + reserved bindings; ESM passes empty sets.

function bodyStatements(body: string) {
  const fn = parseFunctionText(body, 0, body.length);
  return { source: body, statements: fn.body.statements };
}

const ESM_OPTIONS = {
  requiredGuards: new Set<string>(),
  reservedBindings: new Set<string>(),
  missingGuardsErrorAt: 0,
};

describe("classifyModuleItems (format-agnostic security core)", () => {
  it("accepts a guard-free module body when no shadow guards are required (ESM case)", () => {
    const body =
      `function () { const greet = (n) => n + 1; exports.greet = greet; }`;
    const { source, statements } = bodyStatements(body);
    const env = new Map<string, BindingInfo>();
    expect(() =>
      classifyModuleItems(source, "<m>", statements, env, ESM_OPTIONS)
    ).not.toThrow();
  });

  it("still rejects unwrapped mutable top-level data (security rule is format-agnostic)", () => {
    const body =
      `function () { const config = { a: 1 }; exports.config = config; }`;
    const { source, statements } = bodyStatements(body);
    expect(() =>
      classifyModuleItems(
        source,
        "<m>",
        statements,
        new Map<string, BindingInfo>(),
        ESM_OPTIONS,
      )
    ).toThrow(/__cf_data/);
  });

  it("honors empty reservedBindings for const declarations (ESM allows AMD-reserved names)", () => {
    // `define` is an AMD wrapper-reserved name; under ESM (empty reserved set)
    // a const of that name is allowed. Verifies reservedBindings reaches the
    // variable-declaration path, not only the function-declaration path.
    const body =
      `function () { const define = (n) => n; exports.define = define; }`;
    const { source, statements } = bodyStatements(body);
    expect(() =>
      classifyModuleItems(
        source,
        "<m>",
        statements,
        new Map<string, BindingInfo>(),
        ESM_OPTIONS,
      )
    ).not.toThrow();
    // With the AMD reserved set, the same const name is rejected.
    expect(() =>
      classifyModuleItems(
        source,
        "<m>",
        statements,
        new Map<string, BindingInfo>(),
        {
          ...ESM_OPTIONS,
          reservedBindings: new Set(["define"]),
        },
      )
    ).toThrow(/Reserved wrapper binding/);
  });

  it("still rejects top-level mutable bindings (let/var)", () => {
    const body = `function () { let counter = 0; exports.counter = counter; }`;
    const { source, statements } = bodyStatements(body);
    expect(() =>
      classifyModuleItems(
        source,
        "<m>",
        statements,
        new Map<string, BindingInfo>(),
        ESM_OPTIONS,
      )
    ).toThrow(/mutable/i);
  });

  it("classifies a bracket-notation member reference against a known root", () => {
    // Pins the quoted-bracket branch of the member-reference parser
    // (`greet["helper"]`), which compiled bundles only reach when a pattern
    // happens to emit bracket access — CI coverage of it was flapping
    // run-to-run. The root binding is known, so classification succeeds.
    const body =
      `function () { const greet = (n) => n + 1; exports.greet = greet; exports.alias = greet["helper"]; }`;
    const { source, statements } = bodyStatements(body);
    const env = new Map<string, BindingInfo>();
    expect(() =>
      classifyModuleItems(source, "<m>", statements, env, ESM_OPTIONS)
    ).not.toThrow();
  });

  it("rejects bracket notation with a non-string or unterminated key", () => {
    // The parser only admits quoted keys; a computed index falls out of the
    // member grammar and the reference is rejected as a top-level value.
    const body =
      `function () { const greet = (n) => n + 1; exports.greet = greet; exports.alias = greet[0]; }`;
    const { source, statements } = bodyStatements(body);
    expect(() =>
      classifyModuleItems(
        source,
        "<m>",
        statements,
        new Map<string, BindingInfo>(),
        ESM_OPTIONS,
      )
    ).toThrow(/SES mode/);
  });
});
