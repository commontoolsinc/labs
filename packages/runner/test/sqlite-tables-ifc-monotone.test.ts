import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { growOnlyMergeDbTables } from "../src/builtins/sqlite-builtins.ts";

// Audit S8: a db handle's per-column `ifc` lives in mutable handle-cell value
// data, outside the schema-envelope monotonicity the labelMap enforces. A
// re-derivation reading a weaker `tables` input could silently lower a column's
// read label or widen its write ceiling — a store's effective label going DOWN,
// which §8.12.1 forbids. growOnlyMergeDbTables clamps every re-derivation to be
// monotone (strengthen-only) against the prior committed handle value.
const table = (
  cols: Record<string, Record<string, unknown>>,
) => ({ type: "object", properties: cols });

describe("growOnlyMergeDbTables (audit S8)", () => {
  it("passes the declared tables through unchanged on first creation", () => {
    const next = {
      emails: table({ from: { ifc: { confidentiality: ["sender"] } } }),
    };
    expect(growOnlyMergeDbTables(undefined, next)).toEqual(next);
  });

  it("keeps a prior read label that a re-derivation tries to DROP", () => {
    const prior = {
      emails: table({ from: { ifc: { confidentiality: ["sender"] } } }),
    };
    // Attacker / weaker re-declaration: the column loses its ifc.
    const next = { emails: table({ from: {} }) };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<string, { ifc?: { confidentiality?: unknown[] } }>;
    }>;
    expect(merged.emails.properties.from.ifc?.confidentiality).toEqual([
      "sender",
    ]);
  });

  it("unions confidentiality/integrity (strengthening is allowed)", () => {
    const prior = {
      t: table({ c: { ifc: { confidentiality: ["a"], integrity: ["x"] } } }),
    };
    const next = {
      t: table({ c: { ifc: { confidentiality: ["b"], integrity: ["y"] } } }),
    };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<
        string,
        { ifc?: { confidentiality?: unknown[]; integrity?: unknown[] } }
      >;
    }>;
    expect(merged.t.properties.c.ifc?.confidentiality).toEqual(["a", "b"]);
    expect(merged.t.properties.c.ifc?.integrity).toEqual(["x", "y"]);
  });

  it("never widens a write ceiling: a present ceiling can't be removed", () => {
    const prior = {
      t: table({ c: { ifc: { maxConfidentiality: ["lo"] } } }),
    };
    // Re-derivation drops the ceiling (would make the column unlimited).
    const next = { t: table({ c: {} }) };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<
        string,
        { ifc?: { maxConfidentiality?: unknown[] } }
      >;
    }>;
    expect(merged.t.properties.c.ifc?.maxConfidentiality).toEqual(["lo"]);
  });

  it("tightens a write ceiling to the intersection when both are present", () => {
    const prior = {
      t: table({ c: { ifc: { maxConfidentiality: ["a", "b"] } } }),
    };
    const next = {
      t: table({ c: { ifc: { maxConfidentiality: ["b", "c"] } } }),
    };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<
        string,
        { ifc?: { maxConfidentiality?: unknown[] } }
      >;
    }>;
    // Only the meet survives — the smaller allowed set.
    expect(merged.t.properties.c.ifc?.maxConfidentiality).toEqual(["b"]);
  });

  it("restores a labeled table that a re-derivation drops entirely", () => {
    const prior = {
      secrets: table({ k: { ifc: { confidentiality: ["s"] } } }),
    };
    const next = { other: table({ x: {} }) };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<string, { ifc?: { confidentiality?: unknown[] } }>;
    }>;
    expect(merged.secrets.properties.k.ifc?.confidentiality).toEqual(["s"]);
    expect(merged.other).toBeDefined();
  });

  it("restores a labeled column dropped from a still-present table", () => {
    const prior = {
      t: table({
        secret: { type: "string", ifc: { confidentiality: ["s"] } },
        plain: { type: "string" },
      }),
    };
    // Table stays, but the labeled column is removed entirely.
    const next = { t: table({ plain: { type: "string" } }) };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<
        string,
        { type?: string; ifc?: { confidentiality?: unknown[] } }
      >;
    }>;
    // The whole column comes back — its non-ifc structure (`type`) included.
    expect(merged.t.properties.secret.type).toEqual("string");
    expect(merged.t.properties.secret.ifc?.confidentiality).toEqual(["s"]);
    expect(merged.t.properties.plain).toBeDefined();
  });

  it("lets new columns and a stricter re-declaration through", () => {
    const prior = { t: table({ a: { ifc: { confidentiality: ["x"] } } }) };
    const next = {
      t: table({
        a: { ifc: { confidentiality: ["x"], integrity: ["new"] } }, // stricter
        b: { ifc: { confidentiality: ["y"] } }, // new column
      }),
    };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<
        string,
        { ifc?: { confidentiality?: unknown[]; integrity?: unknown[] } }
      >;
    }>;
    expect(merged.t.properties.a.ifc?.integrity).toEqual(["new"]);
    expect(merged.t.properties.b.ifc?.confidentiality).toEqual(["y"]);
  });
});
