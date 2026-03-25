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

  it("accepts compiled dependencies from the shared runtime-module policy", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commontools/schema", "turndown"], function (require, exports, _schema, turndown_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    turndown_1 = __importDefault(turndown_1);
    exports.default = turndown_1.default;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts verified top-level function references for compiled trusted builders", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commontools"], function (require, exports, commontools_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function sanitize(value) {
      return (value == null ? "" : value).trim();
    }
    exports.default = (0, commontools_1.lift)(sanitize);
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

  it("rejects compiled dependencies outside the shared import policy", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "evil"], function (require, exports, evil) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = evil;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Compiled AMD dependency 'evil' is not allowed in SES mode",
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

  it("accepts canonical compiled named reexports from imports", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "./dep"], function (require, exports, dep_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    Object.defineProperty(exports, "foo", { enumerable: true, get: function () { return dep_1.foo; } });
    exports.default = 42;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts canonical compiled export-star reexports in authored modules", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "./dep"], function (require, exports, dep_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    __exportStar(dep_1, exports);
    exports.default = 42;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("rejects top-level class declarations in compiled authored modules", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commontools"], function (require, exports, commontools_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    class Counter {
      constructor() {
        this.value = 1;
      }
      next() {
        return this.value + parseInt("2", 10);
      }
    }
    exports.default = (0, commontools_1.lift)(() => new Counter().next());
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Top-level class declarations are not allowed in SES mode",
    );
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

  it("accepts ambient fetch captures in compiled callbacks", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commontools"], function (require, exports, commontools_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = (0, commontools_1.lift)(() => typeof fetch !== "undefined");
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts ambient base64 helpers in compiled callbacks", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commontools"], function (require, exports, commontools_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = (0, commontools_1.lift)(() => atob("YQ=="));
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts compiled __ct_data() references rewritten through exports", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commontools"], function (require, exports, commontools_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MODULE_METADATA = exports.STANDARD_LABELS = void 0;
    exports.STANDARD_LABELS = (0, commontools_1.__ct_data)(["Personal", "Work"]);
    exports.MODULE_METADATA = (0, commontools_1.__ct_data)({
      type: "email",
      label: "Email",
      schema: {
        label: {
          enum: exports.STANDARD_LABELS,
        },
      },
    });
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("rejects nested closure captures of unsafe top-level state in compiled callbacks", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commontools"], function (require, exports, commontools_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const state = { count: 0 };
    exports.default = (0, commontools_1.lift)(() => {
      const local = 1;
      return () => state.count + local;
    });
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Callback captures top-level data binding 'state'",
    );
  });
});
