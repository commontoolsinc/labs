import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { verifyCompiledBundleModuleFactories } from "../src/sandbox/mod.ts";

describe("verifyCompiledBundleModuleFactories()", () => {
  it("accepts compiled authored module factories", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commontools"], function (require, exports, commontools_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = (0, commontools_1.lift)(() => 42);
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("rejects mutable compiled module state", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commontools"], function (require, exports, commontools_1) {
    "use strict";
    let counter = 0;
    exports.default = (0, commontools_1.lift)(() => ++counter);
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Top-level mutable bindings are not allowed in SES mode",
    );
  });

  it("rejects dynamic import() inside compiled callbacks", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commontools"], function (require, exports, commontools_1) {
    "use strict";
    exports.default = (0, commontools_1.lift)(async () => await import("./helper"));
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Dynamic import() is not allowed in SES mode",
    );
  });

  it("accepts canonical compiled function hardening", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    function __ctHardenFn(fn) {
      Object.freeze(fn);
      const prototype = fn.prototype;
      if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
      }
      return fn;
    }
    const step = __ctHardenFn(() => 42);
    exports.default = step;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts compiled default-import normalization", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "./dep"], function (require, exports, dep_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    dep_1 = __importDefault(dep_1);
    exports.default = dep_1.default;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts pure ambient global helper captures in compiled callbacks", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commontools"], function (require, exports, commontools_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = (0, commontools_1.lift)(() => ({
      parsed: parseInt("42", 10),
      float: parseFloat("3.14"),
      nan: isNaN(Number("x")),
      finite: isFinite(12),
    }));
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });
});
