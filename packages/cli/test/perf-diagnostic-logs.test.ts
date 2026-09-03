import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { isPerfDiagnosticWarnKey } from "../lib/perf-diagnostic-logs.ts";

describe("isPerfDiagnosticWarnKey()", () => {
  it("returns `true` for the key a slow traversal reports under", () => {
    expect(isPerfDiagnosticWarnKey("traverse", "slow-traverse")).toBe(true);
  });

  it("returns `true` for a slow `Cell.get`, whose key carries its bucket", () => {
    expect(isPerfDiagnosticWarnKey("cell", "get >210ms")).toBe(true);
  });

  it("returns `false` for a perf key another logger emitted", () => {
    expect(isPerfDiagnosticWarnKey("cell", "slow-traverse")).toBe(false);
  });

  it("returns `false` for another key of a logger that has a perf key", () => {
    expect(isPerfDiagnosticWarnKey("cell", "pull")).toBe(false);
  });
});
