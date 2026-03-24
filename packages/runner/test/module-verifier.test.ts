import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Program } from "@commontools/js-compiler";
import { verifyProgramModuleScope } from "../src/sandbox/module-verifier.ts";

describe("verifyProgramModuleScope()", () => {
  it("allows trusted runtime imports and local static imports", () => {
    const program: Program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { lift } from "commontools";',
            'import { value } from "./helper.ts";',
            "export default lift(() => value);",
          ].join("\n"),
        },
        {
          name: "/helper.ts",
          contents: "export const value = 1;",
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).not.toThrow();
  });

  it("rejects non-local external static imports", () => {
    const program: Program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { readFileSync } from "node:fs";',
            "export default readFileSync;",
          ].join("\n"),
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).toThrow(
      "Static import 'node:fs' is not allowed in SES mode",
    );
  });

  it("rejects dynamic import() inside builder callbacks", () => {
    const program: Program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { lift } from "commontools";',
            "export default lift(async () => {",
            '  const mod = await import("./helper.ts");',
            "  return mod.value;",
            "});",
          ].join("\n"),
        },
        {
          name: "/helper.ts",
          contents: "export const value = 1;",
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).toThrow(
      "Dynamic import() is not allowed in SES mode",
    );
  });

  it("accepts canonical top-level function hardening", () => {
    const program: Program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "function __ctHardenFn(fn: Function) {",
            "  Object.freeze(fn);",
            "  const prototype = fn.prototype;",
            '  if (prototype && typeof prototype === "object") {',
            "    Object.freeze(prototype);",
            "  }",
            "  return fn;",
            "}",
            "function step() {",
            "  return 1;",
            "}",
            "__ctHardenFn(step);",
            "export default step;",
          ].join("\n"),
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).not.toThrow();
  });

  it("accepts __ct_data() with intrinsic collection helpers and local helpers", () => {
    const program: Program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { __ct_data, safeDateNow } from "commontools";',
            "function buildYears() {",
            "  const currentYear = new Date(safeDateNow()).getFullYear();",
            "  const years: string[] = [];",
            "  for (let year = currentYear; year >= currentYear - 2; year--) {",
            "    years.push(String(year));",
            "  }",
            "  return years;",
            "}",
            'const scopeMap = { gmail: "gmail.readonly" } as const;',
            "const years = __ct_data(buildYears());",
            "const scopes = __ct_data(",
            "  Object.fromEntries(",
            "    Object.entries(scopeMap).map(([key, value]) => [key, { value }]),",
            "  ),",
            ");",
            "export default { years, scopes };",
          ].join("\n"),
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).not.toThrow();
  });
});
