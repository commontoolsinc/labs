import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  formatMemWriteTrace,
  memwriteHash,
  stableStringify,
} from "./memwrite-trace.ts";

describe("memwrite-trace", () => {
  describe("stableStringify", () => {
    it("sorts object keys, so equal content renders identically", () => {
      expect(stableStringify({ b: 1, a: 2 })).toBe(
        stableStringify({ a: 2, b: 1 }),
      );
      expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });

    it("preserves array order and tolerates cycles", () => {
      expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(stableStringify(cyclic)).toContain("[circular]");
    });

    it("falls back to String(value) when a value is not JSON-serializable", () => {
      // BigInt can't be JSON.stringify'd, so the catch fallback runs.
      expect(stableStringify(1n)).toBe("1");
    });
  });

  describe("memwriteHash", () => {
    it("is deterministic and distinguishes different content", () => {
      expect(memwriteHash("abc")).toBe(memwriteHash("abc"));
      expect(memwriteHash("abc")).not.toBe(memwriteHash("abd"));
      expect(memwriteHash("")).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  describe("formatMemWriteTrace", () => {
    it("tags the connection and includes op/id/scope/vhash/paths", () => {
      const line = formatMemWriteTrace(
        { op: "set", id: "of:fid1:abc", scope: "space", value: { x: 1 } },
        3,
        false,
      );
      expect(line).toContain("c=3");
      expect(line).toContain("op=set");
      expect(line).toContain("vhash=");
      expect(line).toContain("paths=[]");
    });

    it("omits raw values by default and includes them only when asked", () => {
      const op = {
        op: "set",
        id: "i",
        scope: "space",
        value: { secret: "shh" },
      };
      const hashed = formatMemWriteTrace(op, 1, false);
      expect(hashed).not.toContain("val=");
      expect(hashed).not.toContain("shh"); // raw value never leaks by default
      const withValues = formatMemWriteTrace(op, 1, true);
      expect(withValues).toContain("val=");
      expect(withValues).toContain("shh");
    });

    it("hashes patch values (where op.value is absent) and extracts paths", () => {
      const op = {
        op: "patch",
        id: "i",
        scope: "space",
        patches: [{ path: "/a", value: 1 }, { path: "/b", value: 2 }],
      };
      const line = formatMemWriteTrace(op, 2, false);
      expect(line).toContain("paths=[/a,/b]");
      expect(line).not.toContain("vhash=--------"); // a value is present
    });

    it("marks a value-less op (e.g. delete) with the empty-hash sentinel", () => {
      const line = formatMemWriteTrace(
        { op: "delete", id: "i", scope: "space" },
        1,
        false,
      );
      expect(line).toContain("vhash=--------");
    });

    it("hashes equal content equally regardless of key order", () => {
      // This is the property the storm investigation leans on: two writes with
      // the same content get the same vhash, so a *different* vhash means a
      // genuinely divergent value, not just reordered keys.
      const vhashOf = (s: string) => s.match(/vhash=(\S+)/)?.[1];
      const a = formatMemWriteTrace(
        { op: "set", id: "i", scope: "space", value: { x: 1, y: 2 } },
        1,
        false,
      );
      const b = formatMemWriteTrace(
        { op: "set", id: "i", scope: "space", value: { y: 2, x: 1 } },
        1,
        false,
      );
      expect(vhashOf(a)).toBe(vhashOf(b));
    });
  });
});
