import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  coverageGate,
  coveredMembers,
  measuredUnits,
  memberSlug,
  membersTouched,
} from "./coverage.ts";
import { EXCLUDED_FROM_COVERAGE_GATE } from "./policy.ts";

const MEMBERS = [
  "./packages/memory",
  "./packages/connectors/github",
  "./packages/runner",
  "./tasks",
];

describe("coverage", () => {
  it("covers every workspace member under packages that is not excluded", () => {
    // Membership follows the workspace rather than a path depth, so a
    // package nested two deep is covered on the same terms as one nested
    // one, and a package outside `packages/` is not covered at all.
    expect(coveredMembers(MEMBERS)).toEqual([
      "packages/connectors/github",
      "packages/memory",
    ]);
    expect(EXCLUDED_FROM_COVERAGE_GATE.has("packages/runner")).toBe(true);
  });

  it("charges a file to the deepest member that holds it", () => {
    // `packages/connectors/github/src/x.ts` belongs to the connector
    // rather than to a `packages/connectors` that happens to be a member
    // too, so a change there scores the package somebody edited.
    expect(
      membersTouched(
        [...MEMBERS, "./packages/connectors"],
        new Set(["packages/connectors/github/src/api.ts"]),
      ),
    ).toEqual(["packages/connectors/github"]);
  });

  it("names no member for a change that reaches none of them", () => {
    expect(membersTouched(MEMBERS, new Set(["docs/README.md"]))).toEqual([]);
    expect(coverageGate(MEMBERS, new Set(["docs/README.md"])))
      .toEqual({ members: [] });
  });

  it("turns the gate off for a change touching more than the cap", () => {
    // Off entirely rather than off for some of them: gating two of the
    // four packages a change touched would mean quietly ignoring the
    // other two, and a cliff is at least predictable from the diff.
    const gate = coverageGate(
      MEMBERS,
      new Set([
        "packages/memory/src/a.ts",
        "packages/connectors/github/src/b.ts",
      ]),
      1,
    );
    expect(gate.members).toEqual([]);
    expect(gate.off).toContain("2 covered packages");
  });

  it("gates a change that stays within the cap", () => {
    const gate = coverageGate(
      MEMBERS,
      new Set(["packages/memory/src/a.ts", "packages/runner/src/b.ts"]),
      1,
    );
    expect(gate.members).toEqual(["packages/memory"]);
    expect(gate.off).toBeUndefined();
  });

  it("makes a gated member's own tests the measured set", () => {
    // The browser half measures none of the source the gate scores, so
    // making it mandatory would start a browser for a figure it cannot
    // move.
    const units = [
      "packages/memory/test/a.test.ts",
      "packages/memory/test/b.test.ts",
      "packages/memory#browser-test",
      "packages/other/test/c.test.ts",
    ];
    expect(
      measuredUnits("workspace-unit", units, new Set(["packages/memory"])),
    ).toEqual([
      "packages/memory/test/a.test.ts",
      "packages/memory/test/b.test.ts",
    ]);
  });

  it("measures nothing outside the suites a member's own tests run in", () => {
    expect(
      measuredUnits(
        "pattern-integration",
        ["packages/memory/test/a.test.ts"],
        new Set(["packages/memory"]),
      ),
    ).toEqual([]);
    expect(
      measuredUnits(
        "workspace-unit",
        ["packages/memory/test/a.test.ts"],
        new Set(),
      ),
    ).toEqual([]);
  });

  it("names a member's report the way its coverage directory is named", () => {
    expect(memberSlug("packages/memory")).toBe("memory");
    expect(memberSlug("./packages/connectors/github")).toBe(
      "connectors__github",
    );
  });
});
