import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { createWriteOnceExports } from "../src/sandbox/module-record-compiler.ts";

// The ESM loader hands the module body a write-once exports object so a write
// smuggled into the evaluation of an otherwise-accepted expression (e.g. a
// comma side effect inside a `__cf_data(...)` argument) cannot overwrite an
// already-assigned export with attacker-controlled state before the loader
// snapshots it into the (SES-immutable) namespace. These tests pin that
// behavior, plus the legitimate compiler shapes that must still work.

describe("createWriteOnceExports", () => {
  it("locks a property after a real assignment (blocks the overwrite smuggle)", () => {
    const exports = createWriteOnceExports();
    exports.token = "verified-data";
    // The smuggled `exports.token = evilClosure` inside a later accepted
    // expression must throw rather than silently corrupt the export.
    expect(() => {
      exports.token = () => "pwned";
    }).toThrow(/write-once/);
    expect(exports.token).toBe("verified-data");
  });

  it("allows the `exports.x = void 0; … exports.x = real;` forward-decl shape", () => {
    const exports = createWriteOnceExports();
    // TS CommonJS output forward-declares exports as `void 0` in the preamble.
    exports.value = undefined;
    exports.value = undefined; // chained `exports.a = exports.b = void 0`
    // The real assignment is permitted and then locks the binding.
    exports.value = 42;
    expect(exports.value).toBe(42);
    expect(() => {
      exports.value = 99;
    }).toThrow(/write-once/);
  });

  it("allows a re-export getter to be defined once, blocks redefinition", () => {
    const exports = createWriteOnceExports();
    Object.defineProperty(exports, "reexported", {
      enumerable: true,
      configurable: true,
      get: () => "from-dep",
    });
    expect(exports.reexported).toBe("from-dep");
    // A second define (e.g. smuggled `Object.defineProperty(exports, …)`) throws.
    expect(() => {
      Object.defineProperty(exports, "reexported", { value: () => "pwned" });
    }).toThrow(/write-once/);
  });

  it("allows the __esModule marker and locks it", () => {
    const exports = createWriteOnceExports();
    Object.defineProperty(exports, "__esModule", { value: true });
    expect(exports.__esModule).toBe(true);
    expect(() => {
      exports.__esModule = false;
    }).toThrow(/write-once/);
  });

  it("blocks deletion of an export (e.g. `delete exports.__esModule`)", () => {
    const exports = createWriteOnceExports();
    exports.keep = 1;
    expect(() => {
      delete exports.keep;
    }).toThrow(/cannot be deleted/);
    expect(exports.keep).toBe(1);
  });

  it("fails closed when a smuggle assigns before the real assignment", () => {
    const exports = createWriteOnceExports();
    // Smuggle runs first (e.g. an import-preamble data arg evaluated early),
    // setting a real value and locking the binding…
    exports.api = () => "pwned";
    // …so the module's own legitimate assignment then throws — the module fails
    // to load rather than exporting a corrupted-but-accepted value.
    expect(() => {
      exports.api = "verified-data";
    }).toThrow(/write-once/);
  });

  it("treats distinct exports independently", () => {
    const exports = createWriteOnceExports();
    exports.a = 1;
    exports.b = 2;
    expect(exports.a).toBe(1);
    expect(exports.b).toBe(2);
    expect(() => {
      exports.a = 3;
    }).toThrow();
  });
});
