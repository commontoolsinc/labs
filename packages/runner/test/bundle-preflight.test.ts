import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getAMDLoader } from "../../js-compiler/typescript/bundler/amd-loader.ts";
import { preflightCompiledBundle } from "../src/sandbox/mod.ts";

const LOADER_SOURCE = getAMDLoader.toString();

function bundleWithCanonicalLoader(body: string): string {
  return `
((runtimeDeps = {}) => {
  const { define, require } = (${LOADER_SOURCE})();
${body}
});
`;
}

function bundleWithHookedLoader(body: string): string {
  return `
((runtimeDeps = {}) => {
  const __ctAmdHooks = runtimeDeps.__ctAmdHooks ?? {};
  const { define, require } = (${LOADER_SOURCE})(__ctAmdHooks);
  for (const [name, dep] of Object.entries(runtimeDeps)) {
    if (name === "__ctAmdHooks") continue;
    define(name, ["exports"], exports => Object.assign(exports, dep));
  }
${body}
});
`;
}

describe("preflightCompiledBundle()", () => {
  it("accepts a define-only AMD bundle shell", () => {
    const bundle = bundleWithCanonicalLoader(`
  for (const [name, dep] of Object.entries(runtimeDeps)) {
    define(name, ["exports"], exports => Object.assign(exports, dep));
  }
  const console = globalThis.console;
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    exports.default = 42;
  });
  return require("main");
`);

    expect(() => preflightCompiledBundle(bundle)).not.toThrow();
  });

  it("accepts the hook-enabled AMD bundle shell", () => {
    const bundle = bundleWithHookedLoader(`
  const console = globalThis.console;
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    exports.default = 42;
  });
  return require("main");
`);

    expect(() => preflightCompiledBundle(bundle)).not.toThrow();
  });

  it("accepts canonical tslib helper IIFE initializers", () => {
    const bundle = bundleWithCanonicalLoader(`
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
`);

    expect(() => preflightCompiledBundle(bundle)).not.toThrow();
  });

  it("accepts compiler-emitted __importStar helper initializers", () => {
    const bundle = bundleWithCanonicalLoader(`
  var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function (o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
  }) : function (o, v) {
    o["default"] = v;
  });
  var __importStar = (this && this.__importStar) || (function () {
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
      __setModuleDefault(result, mod);
      return result;
    };
  })();
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    exports.default = 42;
  });
  return require("main");
`);

    expect(() => preflightCompiledBundle(bundle)).not.toThrow();
  });

  it("accepts regex literals inside compiled module factories", () => {
    const bundle = bundleWithCanonicalLoader(`
  define("main", ["require", "exports", "commontools"], function (require, exports, commontools_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function clean(content) {
      return content.replace(/\\n+/g, " ").trim();
    }
    exports.default = (0, commontools_1.lift)(clean);
  });
  return require("main");
`);

    expect(() => preflightCompiledBundle(bundle)).not.toThrow();
  });

  it("rejects executable code outside AMD registrations", () => {
    const bundle = bundleWithCanonicalLoader(`
  breakOut();
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    exports.default = 42;
  });
  return require("main");
`);

    expect(() => preflightCompiledBundle(bundle)).toThrow(
      "unsupported top-level executable code",
    );
  });

  it("rejects tail declarations with extra side-effectful bindings", () => {
    const bundle = bundleWithCanonicalLoader(`
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    exports.default = 42;
  });
  const main = require("main"), leaked = breakOut();
  return main;
`);

    expect(() => preflightCompiledBundle(bundle)).toThrow(
      "unsupported top-level executable code",
    );
  });

  it("rejects bootstrap helper declarations with executable initializers", () => {
    const bundle = bundleWithCanonicalLoader(`
  var __importDefault = breakOut();
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    exports.default = 42;
  });
  return require("main");
`);

    expect(() => preflightCompiledBundle(bundle)).toThrow(
      "unsupported top-level executable code",
    );
  });

  it("rejects arbitrary return expressions in the bundle tail", () => {
    const bundle = bundleWithCanonicalLoader(`
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    exports.default = 42;
  });
  return breakOut();
`);

    expect(() => preflightCompiledBundle(bundle)).toThrow(
      "unsupported top-level executable code",
    );
  });

  it("rejects arbitrary globalThis bootstrap bindings", () => {
    const bundle = bundleWithCanonicalLoader(`
  const leaked = globalThis.process;
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    exports.default = 42;
  });
  return require("main");
`);

    expect(() => preflightCompiledBundle(bundle)).toThrow(
      "unsupported top-level executable code",
    );
  });
});
