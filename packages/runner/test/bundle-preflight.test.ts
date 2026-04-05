import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { parseCompiledBundleSource } from "../src/sandbox/compiled-js-parser.ts";
import {
  preflightCompiledBundle,
  preflightParsedCompiledBundle,
} from "../src/sandbox/bundle-preflight.ts";
import {
  bundleWithCanonicalLoader,
  bundleWithHookedLoader,
} from "./support/amd-bundles.ts";

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

  it("accepts a previously parsed AMD bundle shell", () => {
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
    const parsedBundle = parseCompiledBundleSource(bundle);

    expect(() => preflightParsedCompiledBundle(bundle, parsedBundle)).not
      .toThrow();
  });

  it("accepts compiler-emitted __importDefault helper initializers", () => {
    const bundle = bundleWithCanonicalLoader(`
  var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
  };
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    exports.default = 42;
  });
  return require("main");
`);

    expect(() => preflightCompiledBundle(bundle)).not.toThrow();
  });

  it("rejects compiler-emitted __importStar helper initializers", () => {
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

    expect(() => preflightCompiledBundle(bundle)).toThrow(
      "unsupported top-level executable code",
    );
  });

  it("accepts standalone __setModuleDefault helper initializers", () => {
    const bundle = bundleWithCanonicalLoader(`
  var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function (o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
  }) : function (o, v) {
    o["default"] = v;
  });
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

  it("accepts complex regex literals with adjacent character classes", () => {
    const bundle = bundleWithCanonicalLoader(`
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    const nestedQuantifiers = /\\([^)]*[+*][^)]*\\)[+*]|\\([^)]*\\)[+*][+*]/;
    exports.default = nestedQuantifiers.test("a");
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

  it("rejects __createBinding helpers with executable injected expressions", () => {
    const bundle = bundleWithCanonicalLoader(`
  var __createBinding = (this && this.__createBinding) || (Object.create ? (((() => breakOut())()), function (o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || (("get" in desc ? !m.__esModule : desc.writable || desc.configurable))) {
      desc = { enumerable: true, get: function () { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
  }) : (function (o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
  }));
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

  it("rejects __exportStar helpers with executable injected statements", () => {
    const bundle = bundleWithCanonicalLoader(`
  var __exportStar = (this && this.__exportStar) || function (m, exports) {
    breakOut();
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
  };
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

  it("rejects canonical __importStar helper IIFE initializers", () => {
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
