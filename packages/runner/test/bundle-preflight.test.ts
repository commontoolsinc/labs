import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { preflightCompiledBundle } from "../src/sandbox/mod.ts";

describe("preflightCompiledBundle()", () => {
  it("accepts a define-only AMD bundle shell", () => {
    const bundle = `
((runtimeDeps = {}) => {
  const { define, require } = (function getAMDLoader() {
    return { define() {}, require() {} };
  })();
  for (const [name, dep] of Object.entries(runtimeDeps)) {
    define(name, ["exports"], (exports) => Object.assign(exports, dep));
  }
  const console = globalThis.RUNTIME_ENGINE_CONSOLE_HOOK;
  var __importStar = function (mod) { return mod; };
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    exports.default = 42;
  });
  return require("main");
});
`;

    expect(() => preflightCompiledBundle(bundle)).not.toThrow();
  });

  it("rejects executable code outside AMD registrations", () => {
    const bundle = `
((runtimeDeps = {}) => {
  const { define, require } = (function getAMDLoader() {
    return { define() {}, require() {} };
  })();
  breakOut();
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    exports.default = 42;
  });
  return require("main");
});
`;

    expect(() => preflightCompiledBundle(bundle)).toThrow(
      "unsupported top-level executable code",
    );
  });
});
