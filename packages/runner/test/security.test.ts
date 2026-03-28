import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  createCallbackCompartmentGlobals,
  createModuleCompartmentGlobals,
  evaluateFunctionSourceInSES,
} from "../src/sandbox/mod.ts";
import { getAMDLoader } from "../../js-compiler/typescript/bundler/amd-loader.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("SES security regressions", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("rejects top-level mutable state before evaluation", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "let leaked = 0;",
            "export default function next() {",
            "  leaked += 1;",
            "  return leaked;",
            "}",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compile(program)).rejects.toThrow(
      "Top-level mutable bindings are not allowed in SES mode",
    );
  });

  it("exposes compatibility fetch without exposing other host globals", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "export default function probe() {",
            "  const host = globalThis as Record<string, unknown>;",
            "  return {",
            '    hasProcess: typeof host.process !== "undefined",',
            '    hasFetch: typeof host.fetch !== "undefined",',
            '    hasStructuredClone: typeof host.structuredClone !== "undefined",',
            '    hasProxy: typeof host.Proxy !== "undefined",',
            '    hasProxyKey: Object.prototype.hasOwnProperty.call(host, "Proxy"),',
            "  };",
            "}",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);

    expect(main?.default()).toEqual({
      hasProcess: false,
      hasFetch: true,
      hasStructuredClone: true,
      hasProxy: false,
      hasProxyKey: true,
    });
  });

  it("keeps module and callback compartments on the same compatibility-global surface", () => {
    expect(
      Object.keys(createCallbackCompartmentGlobals()).sort(),
    ).toEqual(Object.keys(createModuleCompartmentGlobals()).sort());
  });

  it("blocks dynamic import attempts during compile", async () => {
    const program: RuntimeProgram = {
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

    await expect(engine.compile(program)).rejects.toThrow();
  });

  it("exposes compatibility fetch in callback compartments without host internals", () => {
    const probe = engine.getInvocation(`
      function probe() {
        return {
          hasProcess: typeof process !== "undefined",
          hasFetch: typeof fetch !== "undefined",
          hasStructuredClone: typeof structuredClone !== "undefined",
          hasProxy: typeof Proxy !== "undefined",
          hasConsoleHook: typeof globalThis.RUNTIME_ENGINE_CONSOLE_HOOK !== "undefined",
        };
      }
    `) as () => {
      hasProcess: boolean;
      hasFetch: boolean;
      hasStructuredClone: boolean;
      hasProxy: boolean;
      hasConsoleHook: boolean;
    };

    expect(probe()).toEqual({
      hasProcess: false,
      hasFetch: true,
      hasStructuredClone: true,
      hasProxy: false,
      hasConsoleHook: false,
    });
  });

  it("freezes callback compartment globalThis bindings", () => {
    const probe = engine.getInvocation(`
      function probe() {
        "use strict";
        const result = {};

        try {
          globalThis.fetch = undefined;
          result.fetchWrite = "allowed";
        } catch (error) {
          result.fetchWrite = error.name;
        }

        try {
          globalThis.Array = 123;
          result.arrayWrite = "allowed";
        } catch (error) {
          result.arrayWrite = error.name;
        }

        try {
          globalThis.globalThis = 123;
          result.selfWrite = "allowed";
        } catch (error) {
          result.selfWrite = error.name;
        }

        try {
          globalThis.injected = true;
          result.addWrite = "allowed";
        } catch (error) {
          result.addWrite = error.name;
        }

        result.fetchType = typeof fetch;
        result.cloneType = typeof structuredClone;
        result.proxyType = typeof Proxy;
        result.arrayName = Array.name;
        result.hasInjected = "injected" in globalThis;
        return result;
      }
    `) as () => {
      fetchWrite: string;
      arrayWrite: string;
      selfWrite: string;
      addWrite: string;
      fetchType: string;
      cloneType: string;
      proxyType: string;
      arrayName: string;
      hasInjected: boolean;
    };

    expect(probe()).toEqual({
      fetchWrite: "TypeError",
      arrayWrite: "TypeError",
      selfWrite: "TypeError",
      addWrite: "TypeError",
      fetchType: "function",
      cloneType: "function",
      proxyType: "undefined",
      arrayName: "Array",
      hasInjected: false,
    });
  });

  it("freezes module compartment globalThis bindings", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "export default function probe() {",
            '  "use strict";',
            "  const host = globalThis as Record<string, unknown>;",
            "  const result: Record<string, unknown> = {};",
            "  try {",
            "    host.fetch = undefined;",
            '    result.fetchWrite = "allowed";',
            "  } catch (error) {",
            "    result.fetchWrite = (error as Error).name;",
            "  }",
            "  try {",
            "    host.Array = 123;",
            '    result.arrayWrite = "allowed";',
            "  } catch (error) {",
            "    result.arrayWrite = (error as Error).name;",
            "  }",
            "  try {",
            "    host.globalThis = 123;",
            '    result.selfWrite = "allowed";',
            "  } catch (error) {",
            "    result.selfWrite = (error as Error).name;",
            "  }",
            "  try {",
            "    host.injected = true;",
            '    result.addWrite = "allowed";',
            "  } catch (error) {",
            "    result.addWrite = (error as Error).name;",
            "  }",
            "  result.fetchType = typeof fetch;",
            "  result.cloneType = typeof structuredClone;",
            "  result.proxyType = typeof Proxy;",
            "  result.arrayName = Array.name;",
            '  result.hasInjected = "injected" in host;',
            "  return result;",
            "}",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);

    expect(main?.default()).toEqual({
      fetchWrite: "TypeError",
      arrayWrite: "TypeError",
      selfWrite: "TypeError",
      addWrite: "TypeError",
      fetchType: "function",
      cloneType: "function",
      proxyType: "undefined",
      arrayName: "Array",
      hasInjected: false,
    });
  });

  it("does not expose the internal console hook in module compartments", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "export default function probe() {",
            "  const host = globalThis as Record<string, unknown>;",
            "  return {",
            '    hasConsole: typeof console !== "undefined",',
            '    hasConsoleHook: typeof host.RUNTIME_ENGINE_CONSOLE_HOOK !== "undefined",',
            "  };",
            "}",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);

    expect(main?.default()).toEqual({
      hasConsole: true,
      hasConsoleHook: false,
    });
  });

  it("freezes host constructors before exposing them to callback compartments", () => {
    const originalAppend = Headers.prototype.append;

    try {
      const probe = engine.getInvocation(`
        function probe() {
          "use strict";
          try {
            Headers.prototype.append = function hijacked() {};
            return "allowed";
          } catch (error) {
            return error.name;
          }
        }
      `) as () => string;

      expect(probe()).toBe("TypeError");
      expect(Headers.prototype.append).toBe(originalAppend);
    } finally {
      if (Headers.prototype.append !== originalAppend) {
        Headers.prototype.append = originalAppend;
      }
    }
  });

  it("freezes host constructors before exposing them to module compartments", async () => {
    const originalAppend = Headers.prototype.append;

    try {
      const program: RuntimeProgram = {
        main: "/main.ts",
        files: [
          {
            name: "/main.ts",
            contents: [
              "export default function probe() {",
              '  "use strict";',
              "  try {",
              "    Headers.prototype.append = function hijacked() {};",
              '    return "allowed";',
              "  } catch (error) {",
              "    return (error as Error).name;",
              "  }",
              "}",
            ].join("\n"),
          },
        ],
      };

      const { jsScript, id } = await engine.compile(program);
      const { main } = await engine.evaluate(id, jsScript, program.files);

      expect(main?.default()).toBe("TypeError");
      expect(Headers.prototype.append).toBe(originalAppend);
    } finally {
      if (Headers.prototype.append !== originalAppend) {
        Headers.prototype.append = originalAppend;
      }
    }
  });

  it("prevents runtime export poisoning across evaluations", async () => {
    const poisonProgram: RuntimeProgram = {
      main: "/poison.ts",
      files: [
        {
          name: "/poison.ts",
          contents: [
            'import { safeDateNow } from "commontools";',
            "export default function poison() {",
            "  try {",
            "    (safeDateNow as typeof safeDateNow & { poisoned?: number }).poisoned = 123;",
            '    return "allowed";',
            "  } catch (error) {",
            "    return (error as Error).name;",
            "  }",
            "}",
          ].join("\n"),
        },
      ],
    };
    const probeProgram: RuntimeProgram = {
      main: "/probe.ts",
      files: [
        {
          name: "/probe.ts",
          contents: [
            'import { safeDateNow } from "commontools";',
            "export default function probe() {",
            "  return (safeDateNow as typeof safeDateNow & { poisoned?: number }).poisoned ?? 0;",
            "}",
          ].join("\n"),
        },
      ],
    };

    const poisoned = await engine.compile(poisonProgram);
    const poisonResult = await engine.evaluate(
      poisoned.id,
      poisoned.jsScript,
      poisonProgram.files,
    );
    expect(poisonResult.main?.default()).toBe("TypeError");

    const probed = await engine.compile(probeProgram);
    const probeResult = await engine.evaluate(
      probed.id,
      probed.jsScript,
      probeProgram.files,
    );
    expect(probeResult.main?.default()).toBe(0);
  });

  it("makes authored AMD require inert even when called indirectly", async () => {
    const bundle = `
((runtimeDeps = {}) => {
  const { define, require } = (${getAMDLoader.toString()})();
  define("dep", ["require", "exports"], function (require, exports) {
    "use strict";
    exports.default = 42;
  });
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    exports.default = function probe() {
      const alias = ({ call: require }).call;
      try {
        return alias("dep");
      } catch (error) {
        return {
          name: error && error.name,
          message: String(error && error.message ? error.message : error),
        };
      }
    };
  });
  const main = require("main");
  const exportMap = Object.create(null);
  return { main, exportMap };
});
`;

    const { main } = await engine.evaluate(
      "authored-require-probe",
      { js: bundle, filename: "authored-require-probe.js" },
      [],
    );

    expect(main?.default()).toEqual({
      name: "Error",
      message: "Authored AMD require() is unavailable in SES mode",
    });
  });

  it("preserves non-Error throws during SES source evaluation", () => {
    let thrown: unknown;
    try {
      evaluateFunctionSourceInSES(
        `(() => { throw "boom"; })()`,
        { lockdown: true },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe("boom");
  });
});
