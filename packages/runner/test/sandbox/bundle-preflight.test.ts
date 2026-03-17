import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  extractBundleRegion,
  verifyBundlePreflight,
} from "../../src/sandbox/bundle-preflight.ts";
import { verifyAMDFactory } from "../../src/sandbox/module-verifier.ts";

Deno.test("bundle preflight accepts trusted AMD wrapper and rejects outer side effects", async (t) => {
  const validBundle =
    `((runtimeDeps={}) => {const { define, require } = ((hooks)=>({define:hooks.define,require:hooks.require}))({define(){},require(){}});define("main",["exports"],function(exports){/*__CT_TOPLEVEL__:main.tsx:000:lifted:builder*/const lifted=__ct_builder("lift","main.tsx#000:lifted",function(value){return value+1;});exports.default=lifted;});return require("main");});`;

  await t.step("extracts the untrusted define region", () => {
    const region = extractBundleRegion(validBundle);
    assertStringIncludes(region, 'define("main"');
    verifyBundlePreflight(validBundle);
  });

  await t.step("rejects statements before define()", async () => {
    const malicious =
      `((runtimeDeps={}) => {globalThis.__sideEffect = true;const { define, require } = ((hooks)=>({define:hooks.define,require:hooks.require}))({define(){},require(){}});define("main",["exports"],function(exports){});return require("main");});`;
    assertThrows(() => verifyBundlePreflight(malicious));
    assertEquals((globalThis as { __sideEffect?: boolean }).__sideEffect, undefined);
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
});
