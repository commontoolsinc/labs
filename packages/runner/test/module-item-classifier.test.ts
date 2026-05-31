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
});
