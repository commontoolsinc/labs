import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { getPatternEnvironment } from "../src/env.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { createModuleCompartmentGlobals } from "../src/sandbox/mod.ts";
import { createCallbackCompartmentGlobals } from "../src/sandbox/compartment-globals.ts";
import { evaluateFunctionSourceInSES } from "../src/sandbox/ses-runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import {
  bundleWithCanonicalLoader,
  bundleWithGuardedFactory,
  withFactoryGuards,
} from "./support/amd-bundles.ts";

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

  it("exposes frozen host constructors and prototypes to module compartments", () => {
    const globals = createModuleCompartmentGlobals();
    const headersCtor = globals.Headers as typeof Headers;
    const urlCtor = globals.URL as typeof URL;

    expect(typeof headersCtor).toBe("function");
    expect(Object.isFrozen(headersCtor)).toBe(true);
    expect(Object.isFrozen(headersCtor.prototype)).toBe(true);

    expect(typeof urlCtor).toBe("function");
    expect(Object.isFrozen(urlCtor)).toBe(true);
    expect(Object.isFrozen(urlCtor.prototype)).toBe(true);
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
            'import { lift } from "commonfabric";',
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

  it("runs untrusted self-contained direct builder callbacks through the SES fallback", async () => {
    const { commonfabric } = createBuilder();
    const probe = commonfabric.lift((_value: number) => typeof Proxy);
    const testPattern = commonfabric.pattern<{ value: number }>((
      { value },
    ) => ({
      environment: probe(value),
    }));

    const resultCell = runtime.getCell<{ environment: string }>(
      signer.did(),
      "untrusted direct builder callbacks use SES fallback",
      testPattern.resultSchema,
    );

    const result = await runtime.runSynced(resultCell, testPattern, {
      value: 2,
    });
    await expect(result.pull()).resolves.toEqual({ environment: "undefined" });
  });

  it("fails closed when untrusted direct builder callbacks capture host state", async () => {
    const { commonfabric } = createBuilder();
    const secret = { factor: 2 };
    const double = commonfabric.lift((value: number) => value * secret.factor);
    const testPattern = commonfabric.pattern<{ value: number }>((
      { value },
    ) => ({
      total: double(value),
    }));
    const errors: Error[] = [];
    runtime.scheduler.onError((error) => {
      errors.push(error);
    });

    const resultCell = runtime.getCell<{ total: number }>(
      signer.did(),
      "untrusted closureful direct builder callbacks",
      testPattern.resultSchema,
    );

    const result = await runtime.runSynced(resultCell, testPattern, {
      value: 2,
    });
    await result.pull();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/factor|TypeError|ReferenceError/);
  });

  it("allows explicitly trusted direct builder callbacks to preserve host closures", async () => {
    const { commonfabric } = createBuilder({
      unsafeHostTrust: runtime.createUnsafeHostTrust({
        reason: "security regression fixture",
      }),
    });
    const factor = 2;
    const double = commonfabric.lift((value: number) => value * factor);
    const testPattern = commonfabric.pattern<{ value: number }>((
      { value },
    ) => ({
      total: double(value),
    }));

    const resultCell = runtime.getCell<{ total: number }>(
      signer.did(),
      "trusted direct builder callbacks",
      testPattern.resultSchema,
    );

    const result = await runtime.runSynced(resultCell, testPattern, {
      value: 2,
    });
    await expect(result.pull()).resolves.toEqual({ total: 4 });
  });

  it("blesses module-scope handlers referenced only through verified callbacks", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { type Cell, computed, Default, handler, pattern } from "commonfabric";',
            "",
            "interface Args {",
            "  values: Default<number[], []>;",
            "}",
            "",
            "const toInteger = (value: unknown): number =>",
            '  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;',
            "",
            "const adjustFirst = handler(",
            "  (",
            "    event: { amount?: number } | undefined,",
            "    context: { values: Cell<number[]> },",
            "  ) => {",
            "    const target = context.values.key(0) as Cell<number>;",
            "    target.set(toInteger(target.get()) + toInteger(event?.amount));",
            "  },",
            ");",
            "",
            "export default pattern<Args>(({ values }) => ({",
            "  values,",
            "  handlers: computed(() => [adjustFirst({ values })]),",
            "}));",
          ].join("\n"),
        },
      ],
    };

    const compiled = await runtime.patternManager.compilePattern(program);
    const tx = runtime.edit();
    const resultCell = runtime.getCell<any>(
      signer.did(),
      "verified callbacks bless hidden handlers",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(tx, compiled, { values: [2] }, resultCell);
    tx.commit();

    const cancel = result.sink(() => {});
    await runtime.idle();
    await runtime.editWithRetry((tx) =>
      result.key("handlers").key(0).withTx(tx).send({ amount: 3 })
    );
    await runtime.idle();

    await expect(result.key("values").pull()).resolves.toEqual([5]);
    cancel();
  });

  it("blesses nested callbacks created during verified callback execution", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { computed, handler } from "commonfabric";',
            "",
            "const format = (value: string): string => value.toUpperCase();",
            "",
            "export const makeNested = handler(",
            "  (_event, _state) => [computed(() => format('a'))][0],",
            ");",
            "export default makeNested;",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    const { main, loadId } = await engine.evaluate(id, jsScript, program.files);
    const countVerifiedFunctionsForLoad = () =>
      ((engine as unknown as {
        executableRegistry: {
          verifiedFunctions: Map<string, Map<string, unknown>>;
        };
      }).executableRegistry.verifiedFunctions.get(loadId!)?.size) ?? 0;
    const verifiedRegistry = countVerifiedFunctionsForLoad();

    (runtime.runner as unknown as {
      invokeJavaScriptImplementation(
        module: { wrapper?: string },
        fn: (...args: any[]) => unknown,
        argument: unknown,
        verifiedLoadId?: string,
      ): unknown;
    }).invokeJavaScriptImplementation(
      main?.makeNested as { wrapper?: string },
      (main?.makeNested as { implementation: (...args: any[]) => unknown })
        .implementation,
      { $event: undefined, $ctx: undefined },
      loadId,
    );

    const updatedRegistry = countVerifiedFunctionsForLoad();

    expect(updatedRegistry).toBeGreaterThan(verifiedRegistry);
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
            'import { safeDateNow } from "commonfabric";',
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
            'import { safeDateNow } from "commonfabric";',
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

  it("returns fresh pattern environment snapshots across evaluations", async () => {
    const expectedApiUrl = getPatternEnvironment().apiUrl.href;
    const poisonProgram: RuntimeProgram = {
      main: "/poison-env.ts",
      files: [
        {
          name: "/poison-env.ts",
          contents: [
            'import { getPatternEnvironment } from "commonfabric";',
            "export default function poison() {",
            "  const env = getPatternEnvironment();",
            '  env.apiUrl.href = "https://evil.example/";',
            "  return env.apiUrl.href;",
            "}",
          ].join("\n"),
        },
      ],
    };
    const probeProgram: RuntimeProgram = {
      main: "/probe-env.ts",
      files: [
        {
          name: "/probe-env.ts",
          contents: [
            'import { getPatternEnvironment } from "commonfabric";',
            "export default function probe() {",
            "  return getPatternEnvironment().apiUrl.href;",
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
    expect(poisonResult.main?.default()).toBe("https://evil.example/");

    const probed = await engine.compile(probeProgram);
    const probeResult = await engine.evaluate(
      probed.id,
      probed.jsScript,
      probeProgram.files,
    );
    expect(probeResult.main?.default()).toBe(expectedApiUrl);
  });

  it("shadows wrapper-local loader bindings inside compiled callbacks", async () => {
    const { main } = await engine.evaluate(
      "guarded-loader-bindings",
      {
        js: bundleWithGuardedFactory(
          "    function probe() {\n" +
            "      return {\n" +
            "        defineType: typeof define,\n" +
            "        runtimeDepsType: typeof runtimeDeps,\n" +
            "        hooksType: typeof __cfAmdHooks,\n" +
            "      };\n" +
            "    }\n" +
            "    exports.default = (0, commonfabric_1.lift)(probe);",
        ),
        filename: "guarded-loader-bindings.js",
      },
      [],
    );
    const implementation = (main?.default as {
      implementation: () => {
        defineType: string;
        runtimeDepsType: string;
        hooksType: string;
      };
    }).implementation;

    expect(implementation()).toEqual({
      defineType: "undefined",
      runtimeDepsType: "undefined",
      hooksType: "undefined",
    });
  });

  it("prevents loader-backed state from surviving across callback invocations", async () => {
    const { main } = await engine.evaluate(
      "guarded-loader-state",
      {
        js: bundleWithGuardedFactory(
          "    function hiddenState() {\n" +
            '      try { define("__cf_hidden_state", ["exports"], function () { return { value: 1 }; }); return 1; }\n' +
            "      catch { return 2; }\n" +
            "    }\n" +
            "    exports.default = (0, commonfabric_1.lift)(hiddenState);",
        ),
        filename: "guarded-loader-state.js",
      },
      [],
    );
    const implementation = (main?.default as {
      implementation: () => number;
    }).implementation;

    expect(implementation()).toBe(2);
    expect(implementation()).toBe(2);
  });

  it("makes authored AMD require inert even when called indirectly", async () => {
    const bundle = bundleWithCanonicalLoader(`
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
`);

    const { main } = await engine.evaluate(
      "authored-require-probe",
      {
        js: withFactoryGuards(bundle),
        filename: "authored-require-probe.js",
      },
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
