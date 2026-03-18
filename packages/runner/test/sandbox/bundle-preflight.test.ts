import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  extractBundleRegion,
  extractFirstFactoryBody,
  verifyBundlePreflight,
} from "../../src/sandbox/bundle-preflight.ts";
import { verifyAMDFactory } from "../../src/sandbox/module-verifier.ts";
import { Identity } from "@commontools/identity";
import { getAMDLoader } from "../../../js-compiler/typescript/bundler/amd-loader.ts";
import { splitTopLevelStatements } from "../../src/sandbox/token-scanner.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { Runtime } from "../../src/runtime.ts";

Deno.test("bundle preflight accepts trusted AMD wrapper and rejects outer side effects", async (t) => {
  const validBundle = createTrustedBundle(
    `define("main",["exports"],function(exports){/*__CT_TOPLEVEL__:main.tsx:000:lifted:builder*/const lifted=__ct_builder("lift","main.tsx#000:lifted",function(value){return value+1;});exports.default=lifted;});return require("main");`,
  );

  await t.step("extracts the untrusted define region", () => {
    const region = extractBundleRegion(validBundle);
    assertStringIncludes(region, 'define("main"');
    verifyBundlePreflight(validBundle);
  });

  await t.step("rejects statements before define()", async () => {
    const malicious =
      createTrustedBundle(
        `globalThis.__sideEffect = true;define("main",["exports"],function(exports){});return require("main");`,
      );
    assertThrows(() => verifyBundlePreflight(malicious));
    assertEquals((globalThis as { __sideEffect?: boolean }).__sideEffect, undefined);
  });

  await t.step("rejects statements after the trusted AMD wrapper", () => {
    const malicious = `${validBundle}globalThis.__after = true;`;
    assertThrows(() => verifyBundlePreflight(malicious));
    assertEquals((globalThis as { __after?: boolean }).__after, undefined);
  });

  await t.step("allows console use inside verified factories", () => {
    const withConsole = createTrustedBundle(
      `define("main",["exports"],function(exports){console.log("loaded");/*__CT_TOPLEVEL__:main.tsx:000:lifted:builder*/const lifted=__ct_builder("lift","main.tsx#000:lifted",function(value){return value+1;});exports.default=lifted;});return require("main");`,
    );
    verifyBundlePreflight(withConsole);
  });
});

Deno.test("AMD factory verifier enforces canonical wrappers and dependency policy", async (t) => {
  await t.step("accepts trusted runtime imports and same-bundle locals", () => {
    verifyAMDFactory({
      moduleId: "main",
      dependencies: ["exports", "commontools", "./local"],
      registeredModuleIds: new Set(["main", "./local"]),
      factorySource:
        `function(exports, commontools, local){/*__CT_TOPLEVEL__:main.tsx:000:lifted:builder*/const lifted=__ct_builder("lift","main.tsx#000:lifted",function(value){return value+1;});exports.default=lifted;}`,
    });
  });

  await t.step("rejects malformed wrappers", async () => {
    assertThrows(() =>
      verifyAMDFactory({
        moduleId: "main",
        dependencies: ["exports"],
        registeredModuleIds: new Set(["main"]),
        factorySource:
          `function(exports){const lifted=suspicious("lift", function(value){return value+1;});exports.default=lifted;}`,
      })
    );
  });

  await t.step("rejects unexpected module-load statements even with a sentinel", () => {
    assertThrows(() =>
      verifyAMDFactory({
        moduleId: "main",
        dependencies: ["exports"],
        registeredModuleIds: new Set(["main"]),
        factorySource:
          `function(exports){/*__CT_TOPLEVEL__:main.tsx:000:data:data*/const value=__ct_data("main.tsx#000:value",[],1);globalThis.pwned = true;exports.default=value;}`,
      })
    );
  });

  await t.step("rejects non-canonical helper callbacks even when wrapped", () => {
    assertThrows(() =>
      verifyAMDFactory({
        moduleId: "main",
        dependencies: ["exports"],
        registeredModuleIds: new Set(["main"]),
        factorySource:
          `function(exports){/*__CT_TOPLEVEL__:main.tsx:000:fn:pure-fn*/const fn=__ctHelpers.__ct_pure_fn("main.tsx#000:fn",[],function(){globalThis.__pwned = true;return 1;});exports.default=fn;}`,
      })
    );
  });

  await t.step("rejects non-inert __ct_data third arguments before evaluation", () => {
    assertThrows(() =>
      verifyAMDFactory({
        moduleId: "main",
        dependencies: ["exports"],
        registeredModuleIds: new Set(["main"]),
        factorySource:
          `function(exports){/*__CT_TOPLEVEL__:main.tsx:000:value:data*/const value=__ctHelpers.__ct_data("main.tsx#000:value",[],(() => { globalThis.__pwned = true; return 1; })());exports.default=value;}`,
      })
    );
    assertEquals((globalThis as { __pwned?: boolean }).__pwned, undefined);
  });

  await t.step("rejects interpolated template literals in __ct_data third arguments", () => {
    assertThrows(() =>
      verifyAMDFactory({
        moduleId: "main",
        dependencies: ["exports"],
        registeredModuleIds: new Set(["main"]),
        factorySource:
          "function(exports){/*__CT_TOPLEVEL__:main.tsx:000:value:data*/const value=__ctHelpers.__ct_data(\"main.tsx#000:value\",[],`${(() => { globalThis.__pwned = true; return 1; })()}`);exports.default=value;}",
      })
    );
    assertEquals((globalThis as { __pwned?: boolean }).__pwned, undefined);
  });

  await t.step("allows console module-load side effects while rejecting other globals", () => {
    verifyAMDFactory({
      moduleId: "main",
      dependencies: ["exports"],
      registeredModuleIds: new Set(["main"]),
      factorySource:
        `function(exports){console.log("allowed");/*__CT_TOPLEVEL__:main.tsx:000:data:data*/const value=__ct_data("main.tsx#000:value",[],1);exports.default=value;}`,
    });
  });

  await t.step("rejects console module-load side effects hidden in arguments", () => {
    assertThrows(() =>
      verifyAMDFactory({
        moduleId: "main",
        dependencies: ["exports"],
        registeredModuleIds: new Set(["main"]),
        factorySource:
          `function(exports){console.log((globalThis.__pwned = true, "ok"));/*__CT_TOPLEVEL__:main.tsx:000:data:data*/const value=__ct_data("main.tsx#000:value",[],1);exports.default=value;}`,
      })
    );
    assertEquals((globalThis as { __pwned?: boolean }).__pwned, undefined);
  });

  await t.step("rejects non-trusted imports and AMD async require", async () => {
    assertThrows(() =>
      verifyAMDFactory({
        moduleId: "main",
        dependencies: ["exports", "lodash"],
        registeredModuleIds: new Set(["main"]),
        factorySource:
          `function(exports){require(["evil"], function(evil) {});exports.default=1;}`,
      })
    );
  });

  await t.step("rejects aliased async require inside trusted helper callbacks", () => {
    assertThrows(() =>
      verifyAMDFactory({
        moduleId: "main",
        dependencies: ["exports", "require"],
        registeredModuleIds: new Set(["main"]),
        factorySource:
          `function(exports, require){/*__CT_TOPLEVEL__:main.tsx:000:fn:pure-fn*/const fn=__ctHelpers.__ct_pure_fn("main.tsx#000:fn",[],function(){const r=require;r(["evil"], function(){});return 1;});exports.default=fn;}`,
      })
    );
  });
});

Deno.test("AMD factory verifier accepts real compiler output from the SES engine path", async () => {
  const signer = await Identity.fromPassphrase("bundle-preflight verifier");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  try {
    const program = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "import { lift } from 'commontools';",
            "const doubled = lift((value: number) => value * 2);",
            "export default doubled;",
          ].join("\n"),
        },
      ],
    };

    const { jsScript } = await runtime.harness.compile(program);
    const region = extractBundleRegion(jsScript.js);
    const defineSource = splitTopLevelStatements(region).find((statement) =>
      statement.includes("__CT_TOPLEVEL__")
    );
    if (!defineSource) {
      throw new Error("Expected a define(...) region in the compiled bundle");
    }

    verifyBundlePreflight(jsScript.js);
    verifyAMDFactory({
      moduleId: "main",
      dependencies: ["require", "exports", "commontools"],
      registeredModuleIds: new Set(["main"]),
      factorySource: `function(require, exports, __ctHelpers){${
        extractFirstFactoryBody(defineSource)
      }}`,
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("AMD factory verifier accepts real compiler output for direct default-export builders", async () => {
  const signer = await Identity.fromPassphrase("bundle-preflight default export");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  try {
    const program = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "import { pattern } from 'commontools';",
            "export default pattern<{ count: number }>(({ count }) => ({ count }));",
          ].join("\n"),
        },
      ],
    };

    const { jsScript } = await runtime.harness.compile(program);
    verifyBundlePreflight(jsScript.js);

    const region = extractBundleRegion(jsScript.js);
    const defineSource = splitTopLevelStatements(region).find((statement) =>
      statement.includes("__CT_TOPLEVEL__")
    );
    if (!defineSource) {
      throw new Error("Expected a define(...) region in the compiled bundle");
    }

    verifyAMDFactory({
      moduleId: "main",
      dependencies: ["require", "exports", "commontools"],
      registeredModuleIds: new Set(["main"]),
      factorySource: `function(require, exports, __ctHelpers){${
        extractFirstFactoryBody(defineSource)
      }}`,
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("bundle preflight accepts compiled SES bundles with regex-bearing helper callbacks", async () => {
  const signer = await Identity.fromPassphrase("bundle-preflight regex bundle");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  try {
    const program = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "import { lift } from 'commontools';",
            "const sanitize = (value: string) => value.replace(/[^a-z0-9-]+/gi, '-');",
            "const normalized = lift((value: string) => sanitize(value));",
            "export default normalized;",
          ].join("\n"),
        },
      ],
    };

    const { jsScript } = await runtime.harness.compile(program);
    verifyBundlePreflight(jsScript.js);

    const region = extractBundleRegion(jsScript.js);
    const defineSource = splitTopLevelStatements(region).find((statement) =>
      statement.includes("__CT_TOPLEVEL__")
    );
    if (!defineSource) {
      throw new Error("Expected a define(...) region in the compiled bundle");
    }

    verifyAMDFactory({
      moduleId: "main",
      dependencies: ["require", "exports", "commontools"],
      registeredModuleIds: new Set(["main"]),
      factorySource: `function(require, exports, __ctHelpers){${
        extractFirstFactoryBody(defineSource)
      }}`,
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("engine evaluation rejects non-inert top-level data initializers before module-load execution", async () => {
  const signer = await Identity.fromPassphrase("bundle-preflight malicious data");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  try {
    const program = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            'const value = (() => { throw new Error("module-load executed"); })();',
            "export default value;",
          ].join("\n"),
        },
      ],
    };

    const { id, jsScript } = await runtime.harness.compile(program);
    await assertRejects(
      () => runtime.harness.evaluate(id, jsScript, program.files),
      Error,
      "non-canonical top-level statement",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("bundle preflight rejects side-effectful TS helper prelude statements", () => {
  const maliciousBundle = createTrustedBundle(
    `var __createBinding = (this && this.__createBinding) || (globalThis.__preflightPwned = true, function(o, m, k, k2) { if (k2 === undefined) k2 = k; o[k2] = m[k]; });define("main",["exports"],function(exports){exports.default=1;});return require("main");`,
  );

  assertThrows(() => verifyBundlePreflight(maliciousBundle));
  assertEquals(
    (globalThis as { __preflightPwned?: boolean }).__preflightPwned,
    undefined,
  );
});

function createTrustedBundle(body: string): string {
  return stripNewLines(`((runtimeDeps={}) => {
    const __ctAmdHooks = runtimeDeps.__ctAmdHooks ?? {};
    const { define, require } = (${getAMDLoader.toString()})(__ctAmdHooks);
    for (const [name, dep] of Object.entries(runtimeDeps)) {
      if (name === "__ctAmdHooks") continue;
      define(name, ["exports"], exports => Object.assign(exports, dep));
    };
    ${body}
  });`);
}

function stripNewLines(input: string): string {
  return input.replace(/\n/g, "");
}
