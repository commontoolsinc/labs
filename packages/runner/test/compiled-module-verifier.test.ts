import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  parseCompiledBundleSource as parseCompiledBundleSourceRaw,
} from "../src/sandbox/compiled-js-parser.ts";
import {
  verifyCompiledBundleModuleFactoriesWithParser
    as verifyCompiledBundleModuleFactoriesRaw,
  verifyParsedCompiledBundleModuleFactoriesWithParser
    as verifyParsedCompiledBundleModuleFactoriesWithParserRaw,
} from "../src/sandbox/compiled-bundle-verifier.ts";
import { withFactoryGuards } from "./support/amd-bundles.ts";

function parseCompiledBundleSource(bundle: string) {
  return parseCompiledBundleSourceRaw(withFactoryGuards(bundle));
}

function verifyParsedCompiledBundleModuleFactoriesWithParser(
  bundle: string,
  parsedBundle: ReturnType<typeof parseCompiledBundleSourceRaw>,
) {
  return verifyParsedCompiledBundleModuleFactoriesWithParserRaw(
    withFactoryGuards(bundle),
    parsedBundle,
  );
}

function verifyCompiledBundleModuleFactories(bundle: string) {
  return verifyCompiledBundleModuleFactoriesRaw(withFactoryGuards(bundle));
}

describe("verifyCompiledBundleModuleFactories()", () => {
  it("accepts compiled authored module factories", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = (0, commonfabric_1.lift)(() => 42);
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts a previously parsed compiled bundle", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = (0, commonfabric_1.lift)(() => 42);
  });
});
`;
    const parsedBundle = parseCompiledBundleSource(bundle);

    expect(() =>
      verifyParsedCompiledBundleModuleFactoriesWithParser(bundle, parsedBundle)
    ).not.toThrow();
  });

  it("accepts compiled dependencies from the shared runtime-module policy", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric/schema", "turndown"], function (require, exports, _schema, turndown_1) {
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
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function sanitize(value) {
      return (value == null ? "" : value).trim();
    }
    exports.default = (0, commonfabric_1.lift)(sanitize);
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts compiled JSX intrinsic tags inside trusted builder callbacks", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = (0, commonfabric_1.pattern)(() => {
      return {
        ui: h("div", null, h("cf-screen", null, "Hello")),
      };
    });
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts destructured compiled builder callbacks with injected schema args", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const count = (0, commonfabric_1.schema)({ type: "number" });
    exports.default = (0, commonfabric_1.pattern)(({ count: value }) => ({
      data: { value },
    }), false, {
      type: "object",
      properties: {
        data: { type: "object" },
      },
    });
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("rejects mutable compiled module state", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    let counter = 0;
    exports.default = (0, commonfabric_1.lift)(() => ++counter);
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Top-level mutable bindings are not allowed in SES mode",
    );
  });

  it("rejects authored factories that bind reserved wrapper-local names", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    const define = 42;
    exports.default = define;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Reserved wrapper binding",
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
    function __cfHardenFn(fn) {
      Object.freeze(fn);
      const prototype = fn.prototype;
      if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
      }
      return fn;
    }
    const step = __cfHardenFn(() => 42);
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

  it("rejects compiled namespace-import normalization", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "./dep"], function (require, exports, dep_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    dep_1 = __importStar(dep_1);
    exports.default = dep_1.default;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "unsupported top-level executable code",
    );
  });

  it("accepts regex literals inside compiled helper functions", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function clean(content) {
      return content.replace(/\\n+/g, " ").trim();
    }
    exports.default = (0, commonfabric_1.lift)(clean);
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("rejects compiled top-level generator declarations", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    function* foo() {
      yield 1;
    }
    exports.foo = foo;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Compiled AMD module contains unsupported top-level executable code",
    );
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
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
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
    exports.default = (0, commonfabric_1.lift)(() => new Counter().next());
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
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = (0, commonfabric_1.lift)(() => ({
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
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = (0, commonfabric_1.lift)(() => typeof fetch !== "undefined");
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts ambient base64 helpers in compiled callbacks", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = (0, commonfabric_1.lift)(() => atob("YQ=="));
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts compiled __cf_data() with intrinsic collection helpers and local helpers", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function buildYears() {
      const currentYear = new Date((0, commonfabric_1.safeDateNow)()).getFullYear();
      const years = [];
      for (let year = currentYear; year >= currentYear - 2; year--) {
        years.push(String(year));
      }
      return years;
    }
    const scopeMap = (0, commonfabric_1.__cf_data)({ gmail: "gmail.readonly" });
    const years = (0, commonfabric_1.__cf_data)(buildYears());
    const scopes = (0, commonfabric_1.__cf_data)(Object.fromEntries(Object.entries(scopeMap).map(([key, value]) => [key, { value }])));
    const payload = (0, commonfabric_1.__cf_data)({ years, scopes });
    exports.default = payload;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts compiled nested __cfHelpers.__cf_data() runtime helper calls", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const startedAt = commonfabric_1.__cfHelpers.__cf_data((0, commonfabric_1.safeDateNow)());
    const seed = commonfabric_1.__cfHelpers.__cf_data((0, commonfabric_1.nonPrivateRandom)());
    exports.default = (0, commonfabric_1.__cf_data)({ startedAt, seed });
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts compiled __cf_data() references rewritten through exports", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MODULE_METADATA = exports.STANDARD_LABELS = void 0;
    exports.STANDARD_LABELS = (0, commonfabric_1.__cf_data)(["Personal", "Work"]);
    exports.MODULE_METADATA = (0, commonfabric_1.__cf_data)({
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

  it("accepts compiled __cf_data() helpers that use for...of iteration", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function buildIndex() {
      const index = new Map();
      for (const [group, members] of Object.entries({ dairy: ["milk"] })) {
        for (const member of members) {
          index.set(member, [group]);
        }
      }
      return index;
    }
    const parentIndex = (0, commonfabric_1.__cf_data)(buildIndex());
    exports.default = parentIndex;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts compiled callbacks that declare nested callback parameters", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = (0, commonfabric_1.lift)((items) => items.map((_item) => _item + 1));
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts compiled trusted callbacks that contain nested handler parameters", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = (0, commonfabric_1.pattern)(() => ({
      addChild: (0, commonfabric_1.handler)(false, {
        type: "object",
        properties: {
          children: { type: "array", items: { type: "number" }, asCell: true }
        },
        required: ["children"]
      }, (_, { children }) => children.push(1))({ children: [] }),
    }));
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts compiled helper functions that only close over __cf_data()", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const STANDARD_LABELS = (0, commonfabric_1.__cf_data)({ email: ["Personal", "Work"] });
    function getNextUnusedLabel(type) {
      const standards = STANDARD_LABELS[type];
      return standards || undefined;
    }
    exports.default = (0, commonfabric_1.lift)(() => getNextUnusedLabel("email"));
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts compiled __cf_data() accessors with inert bodies", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const data = (0, commonfabric_1.__cf_data)({
      get value() {
        return 1;
      },
      set value(_next) {
        "use strict";
      },
    });
    exports.default = data;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts compiled __cf_data() accessors without inspecting captured bindings", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric", "./helper"], function (require, exports, commonfabric_1, helper_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const data = (0, commonfabric_1.__cf_data)({
      get value() {
        return helper_1.state;
      },
    });
    exports.default = data;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts compiled builder callbacks that capture top-level schema snapshots", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const state = (0, commonfabric_1.schema)({ type: "object", properties: { count: { type: "number" } } });
    exports.default = (0, commonfabric_1.lift)(() => state.type);
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts compiled builder callbacks that reference their own top-level binding", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const Note = (0, commonfabric_1.pattern)(() => ({
      json: JSON.stringify(Note),
    }));
    exports.default = Note;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("accepts compiled callbacks that capture later const helper bindings", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const readValue = (0, commonfabric_1.lift)((value) => formatValue(value));
    const formatValue = (value) => {
      return value;
    };
    exports.default = readValue;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).not.toThrow();
  });

  it("rejects raw mutable compiled top-level exports without __cf_data()", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = {
      nested: { count: 1 },
    };
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Mutable top-level data must be wrapped in __cf_data() in SES mode",
    );
  });

  it("rejects raw top-level helper calls without __cf_data()", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function build() {
      return { count: 1 };
    }
    exports.default = build();
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Top-level call results must be wrapped in __cf_data() in SES mode",
    );
  });

  it("rejects compiled fragment mutation escape hatches at module scope", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function counter() {
      const self = counter;
      self.fragment.count += 1;
      return self.fragment.count;
    }
    counter.fragment = { count: 0 };
    exports.default = counter;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Compiled AMD module contains unsupported top-level executable code",
    );
  });

  it("rejects compiled factories that omit require capture", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["exports"], function (exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = 42;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Compiled AMD factories must shadow outer require with a canonical 'require' dependency parameter",
    );
  });

  it("rejects compiled factories that rename the require capture", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports"], function (__cfRequire, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = 42;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Compiled AMD factories must shadow outer require with a canonical 'require' dependency parameter",
    );
  });

  it("rejects direct authored require() calls in compiled factories", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = require("./dep");
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Top-level call results must be wrapped in __cf_data() in SES mode",
    );
  });

  it("rejects top-level IIFEs that try to hide mutable state in compiled factories", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    const state = (() => ({ count: 0 }))();
    exports.default = 42;
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Only trusted builder calls, schema(), and canonical function hardening are allowed at module scope in SES mode",
    );
  });

  it("rejects top-level patternTool() calls in compiled factories", () => {
    const bundle = `
((runtimeDeps = {}) => {
  define("main", ["require", "exports", "commonfabric"], function (require, exports, commonfabric_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = (0, commonfabric_1.patternTool)(() => ({ ok: true }));
  });
});
`;

    expect(() => verifyCompiledBundleModuleFactories(bundle)).toThrow(
      "Only trusted builder calls, schema(), and canonical function hardening are allowed at module scope in SES mode",
    );
  });
});
