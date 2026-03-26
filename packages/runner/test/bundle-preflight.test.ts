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
  const console = globalThis.console;
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

  it("accepts canonical tslib helper IIFE initializers", () => {
    const bundle = `
((runtimeDeps = {}) => {
  const { define, require } = (function getAMDLoader() {
    return { define() {}, require() {} };
  })();
  var __importStar = (function () {
    var ownKeys = function (o) {
      ownKeys = Object.getOwnPropertyNames || function (o) {
        var ar = [];
        for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
        return ar;
      };
      return ownKeys(o);
    };
    return function (mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) {
        if (k[i] !== "default") result[k[i]] = mod[k[i]];
      }
      return result;
    };
  })();
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

  it("rejects tail declarations with extra side-effectful bindings", () => {
    const bundle = `
((runtimeDeps = {}) => {
  const { define, require } = (function getAMDLoader() {
    return { define() {}, require() {} };
  })();
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    exports.default = 42;
  });
  const main = require("main"), leaked = breakOut();
  return main;
});
`;

    expect(() => preflightCompiledBundle(bundle)).toThrow(
      "unsupported top-level executable code",
    );
  });

  it("rejects bootstrap helper declarations with executable initializers", () => {
    const bundle = `
((runtimeDeps = {}) => {
  const { define, require } = (function getAMDLoader() {
    return { define() {}, require() {} };
  })();
  var __importDefault = breakOut();
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

  it("rejects arbitrary return expressions in the bundle tail", () => {
    const bundle = `
((runtimeDeps = {}) => {
  const { define, require } = (function getAMDLoader() {
    return { define() {}, require() {} };
  })();
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    exports.default = 42;
  });
  return breakOut();
});
`;

    expect(() => preflightCompiledBundle(bundle)).toThrow(
      "unsupported top-level executable code",
    );
  });

  it("rejects arbitrary globalThis bootstrap bindings", () => {
    const bundle = `
((runtimeDeps = {}) => {
  const { define, require } = (function getAMDLoader() {
    return { define() {}, require() {} };
  })();
  const leaked = globalThis.process;
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
