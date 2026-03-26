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

  it("allows trusted runtime imports from the shared module policy", () => {
    const program: Program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import "commontools/schema";',
            'import TurndownService from "turndown";',
            'import { lift } from "commontools";',
            "export default lift(() => typeof TurndownService);",
          ].join("\n"),
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

  it("accepts verified top-level function references for trusted builders", () => {
    const program: Program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { lift } from "commontools";',
            "function sanitize(value: string | undefined) {",
            '  return value?.trim() ?? "";',
            "}",
            "export default lift(sanitize);",
          ].join("\n"),
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).not.toThrow();
  });

  it("ignores JSX intrinsic tags in callback capture analysis", () => {
    const program: Program = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { pattern } from "commontools";',
            "export default pattern(() => {",
            "  return { ui: <div><ct-screen>Hello</ct-screen></div> };",
            "});",
          ].join("\n"),
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).not.toThrow();
  });

  it("rejects top-level class declarations", () => {
    const program: Program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { lift } from "commontools";',
            "class Counter {",
            "  value = 1;",
            "  next() {",
            '    return this.value + parseInt("2", 10);',
            "  }",
            "}",
            "export default lift(() => new Counter().next());",
          ].join("\n"),
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).toThrow(
      "Top-level class declarations are not allowed in SES mode",
    );
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
            'const scopeMap = __ct_data({ gmail: "gmail.readonly" } as const);',
            "const years = __ct_data(buildYears());",
            "const scopes = __ct_data(",
            "  Object.fromEntries(",
            "    Object.entries(scopeMap).map(([key, value]) => [key, { value }]),",
            "  ),",
            ");",
            "const payload = __ct_data({ years, scopes });",
            "export default payload;",
          ].join("\n"),
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).not.toThrow();
  });

  it("rejects raw mutable top-level exports without __ct_data()", () => {
    const program: Program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "export default {",
            "  nested: { count: 1 },",
            "};",
          ].join("\n"),
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).toThrow();
  });

  it("rejects raw top-level helper calls without __ct_data()", () => {
    const program: Program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "function build() {",
            "  return { count: 1 };",
            "}",
            "export default build();",
          ].join("\n"),
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).toThrow(
      "Top-level call results must be wrapped in __ct_data() in SES mode",
    );
  });

  it("rejects fragment mutation escape hatches at module scope", () => {
    const program: Program = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "function counter() {",
            "  const self = counter as typeof counter & { fragment?: { count: number } };",
            "  self.fragment!.count += 1;",
            "  return self.fragment!.count;",
            "}",
            "counter.fragment = { count: 0 };",
            "export default counter;",
          ].join("\n"),
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).toThrow();
  });

  it("accepts __ct_data() helpers that use for...of iteration", () => {
    const program: Program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { __ct_data } from "commontools";',
            "function buildIndex() {",
            "  const index = new Map<string, string[]>();",
            '  for (const [group, members] of Object.entries({ dairy: ["milk"] })) {',
            "    for (const member of members) {",
            "      index.set(member, [group]);",
            "    }",
            "  }",
            "  return index;",
            "}",
            "const parentIndex = __ct_data(buildIndex());",
            "export default parentIndex;",
          ].join("\n"),
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).not.toThrow();
  });

  it("accepts callbacks that capture later const helper bindings", () => {
    const program: Program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { lift } from "commontools";',
            "const readValue = lift((value: number) => formatValue(value));",
            "const formatValue = (value: number) => value;",
            "export default readValue;",
          ].join("\n"),
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).not.toThrow();
  });

  it("rejects nested closure captures of unsafe top-level state", () => {
    const program: Program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { lift, schema } from "commontools";',
            "const state = schema({",
            '  type: "object",',
            '  properties: { count: { type: "number" } },',
            "});",
            "export default lift(() => {",
            "  const local = 1;",
            "  return () => state.type + local;",
            "});",
          ].join("\n"),
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).toThrow(
      "Callback captures top-level data binding 'state'",
    );
  });

  it("accepts verified __ct_data() accessors with inert bodies", () => {
    const program: Program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { __ct_data } from "commontools";',
            "const data = __ct_data({",
            "  get value() {",
            "    return 1;",
            "  },",
            "  set value(_next) {",
            '    "use strict";',
            "  },",
            "});",
            "export default data;",
          ].join("\n"),
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).not.toThrow();
  });

  it("rejects __ct_data() accessors that capture unsafe top-level state", () => {
    const program: Program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { __ct_data } from "commontools";',
            'import { state } from "./helper.ts";',
            "const data = __ct_data({",
            "  get value() {",
            "    return state;",
            "  },",
            "});",
            "export default data;",
          ].join("\n"),
        },
        {
          name: "/helper.ts",
          contents: "export const state = 1;",
        },
      ],
    };

    expect(() => verifyProgramModuleScope(program)).toThrow(
      "__ct_data() cannot capture unsafe top-level identifier 'state'",
    );
  });
});
